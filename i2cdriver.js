/**
 * I2CDriver Web Serial Protocol Implementation
 * Based on https://github.com/jamesbowman/i2cdriver
 *
 * Serial port: 1 Mbaud, 8N1, no flow control
 *
 * Protocol summary:
 *  '?' (0x3F)          → 80-byte ASCII status string
 *  'e' (0x65) + byte   → echo: returns the byte
 *  'd' (0x64)          → bus scan: 112 ASCII '0'/'1' bytes (addr 8–119)
 *  'x' (0x78)          → bus reset: returns 1 byte (bit0=SCL, bit1=SDA)
 *  's' (0x73) + (dev<<1|rw) → start: returns ACK byte
 *  0x80+n-1            → read n bytes (1–64), NAK last
 *  'a' (0x61) + 64     → bulk read 64 bytes (ACK all)
 *  0xC0+n-1 + n bytes  → write n bytes (1–64): returns ACK byte
 *  'p' (0x70)          → stop
 *  'r' (0x72)+dev+reg+n→ register read shortcut (n <= 255)
 *  '1' (0x31)          → set speed 100 kHz
 *  '4' (0x34)          → set speed 400 kHz
 *  'u' (0x75) + mask   → set pullups (6-bit mask)
 */

// ─── Errors ──────────────────────────────────────────────────────────────────

export class I2CDriverError extends Error {
  constructor(msg) { super(msg); this.name = 'I2CDriverError'; }
}

export class I2CTimeoutError extends I2CDriverError {
  constructor(msg = 'I²C Bus Timeout') { super(msg); this.name = 'I2CTimeoutError'; }
}

// ─── Serial Buffer ────────────────────────────────────────────────────────────

/**
 * Byte queue fed by a background pump; supports async reads with timeout.
 */
class SerialBuffer {
  constructor() {
    this._bytes = [];
    this._waiters = [];
  }

  /** Called by the pump for each incoming chunk. */
  push(chunk) {
    for (const b of chunk) this._bytes.push(b);
    this._tryResolve();
  }

  _tryResolve() {
    while (this._waiters.length > 0 && this._bytes.length >= this._waiters[0].n) {
      const { n, resolve, timer } = this._waiters.shift();
      if (timer !== null) clearTimeout(timer);
      resolve(new Uint8Array(this._bytes.splice(0, n)));
    }
  }

  /**
   * Read exactly n bytes. Resolves as soon as enough bytes are available.
   * @param {number} n - byte count
   * @param {number} timeout - ms (0 = no timeout)
   * @returns {Promise<Uint8Array>}
   */
  read(n, timeout = 5000) {
    if (this._bytes.length >= n) {
      return Promise.resolve(new Uint8Array(this._bytes.splice(0, n)));
    }
    return new Promise((resolve, reject) => {
      const waiter = { n, resolve, reject, timer: null };
      if (timeout > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this._waiters.indexOf(waiter);
          if (idx >= 0) {
            this._waiters.splice(idx, 1);
            reject(new I2CDriverError(
              `Timeout beim Lesen (${n} Bytes angefordert, ${this._bytes.length} vorhanden)`
            ));
          }
        }, timeout);
      }
      this._waiters.push(waiter);
    });
  }

  /** Discard all buffered bytes. */
  discard() { this._bytes = []; }

  get available() { return this._bytes.length; }
}

// ─── I2CDriver ────────────────────────────────────────────────────────────────

export class I2CDriver extends EventTarget {
  constructor() {
    super();
    this._port     = null;
    this._writer   = null;
    this._reader   = null;
    this._buf      = new SerialBuffer();
    this._pumpDone = Promise.resolve();
    this._running  = false;
    this._opQueue  = Promise.resolve(); // serial operation mutex
    this.connected = false;

    // Status fields – updated by getStatus()
    this.product  = '';
    this.serial   = '';
    this.uptime   = 0;
    this.voltage  = 0.0;
    this.current  = 0.0;
    this.temp     = 0.0;
    this.mode     = '';
    this.scl      = 1;
    this.sda      = 1;
    this.speed    = 100;
    this.pullups  = 0;
    this.ccittCrc = 0;
  }

  /** True if the browser supports Web Serial. */
  static isSupported() {
    return 'serial' in navigator;
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  async connect() {
    if (!I2CDriver.isSupported()) {
      throw new I2CDriverError(
        'Web Serial API nicht verfügbar. Bitte Chrome ≥89 oder Edge ≥89 verwenden.'
      );
    }

    this._port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x0403, usbProductId: 0x6015 }],  // FTDI FT230X
    });
    await this._port.open({
      baudRate: 1_000_000,
      dataBits: 8,
      stopBits: 1,
      parity:   'none',
    });

    this._writer  = this._port.writable.getWriter();
    this._running = true;
    this._pumpDone = this._pump();

    await this._init();
    this.connected = true;
    this._emit('connected');
  }

  async disconnect() {
    this._running = false;
    try { if (this._reader) await this._reader.cancel(); } catch (_) {}
    try { await this._pumpDone; } catch (_) {}
    try { this._writer.releaseLock(); } catch (_) {}
    try { await this._port.close(); } catch (_) {}
    this.connected = false;
    this._buf.discard();
    this._emit('disconnected');
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  async _pump() {
    this._reader = this._port.readable.getReader();
    try {
      while (this._running) {
        const { value, done } = await this._reader.read();
        if (done) break;
        this._buf.push(value);
      }
    } catch (_) {
      // Port closed or cancelled – expected during disconnect
    } finally {
      this._reader.releaseLock();
      this._reader = null;
    }
  }

  /** Write bytes to the serial port. Accepts number, array, or Uint8Array. */
  async _write(data) {
    if (typeof data === 'number')       data = new Uint8Array([data]);
    else if (Array.isArray(data))       data = new Uint8Array(data);
    await this._writer.write(data);
  }

  async _read(n)     { return this._buf.read(n); }
  _delay(ms)         { return new Promise(r => setTimeout(r, ms)); }

  _emit(type, detail) {
    this.dispatchEvent(
      detail ? new CustomEvent(type, { detail }) : new Event(type)
    );
  }

  /**
   * Serialise all public serial operations so that concurrent callers
   * (polling timer, auto-refresh, manual buttons, scripts) never
   * interleave bytes on the wire.
   */
  _enqueue(fn) {
    const next = this._opQueue.then(() => fn());
    this._opQueue = next.catch(() => {}); // errors must not block the queue
    return next;
  }

  async _init() {
    // Exit capture/monitor mode; send 65× '@' to flush the device's command buffer
    const resetSeq = new Uint8Array(65).fill(0x40); // '@'
    await this._write(resetSeq);
    await this._delay(300);
    this._buf.discard(); // throw away any device noise

    // Echo test: verify the device is responding correctly
    for (const c of [0x55, 0x00, 0xFF, 0xAA]) {
      await this._write([0x65, c]); // 'e', c
      const r = await this._read(1);
      if (r[0] !== c) {
        throw new I2CDriverError(
          `Echo-Test fehlgeschlagen (erwartet 0x${c.toString(16).padStart(2,'0')},` +
          ` erhalten 0x${r[0].toString(16).padStart(2,'0')})`
        );
      }
    }

    await this.getStatus();
    const busState = await this.reset();
    if ((busState & 3) !== 3) {
      console.warn('I2CDriver: Bus-Reset – SCL/SDA nicht beide HIGH.');
    }
    await this.setSpeed(100);
  }

  async _ack() {
    const r = await this._read(1);
    if (r[0] & 2) throw new I2CTimeoutError();
    return (r[0] & 1) !== 0;
  }

  // ─── Status & Configuration ──────────────────────────────────────────────────

  /** Query and update all status fields. */
  async getStatus() {
    return this._enqueue(async () => {
      await this._write(0x3F); // '?'
      const r = await this._read(80);
      // Response format: "[product serial uptime voltage current temp mode sda scl speed pullups crc]\n"
      const txt  = new TextDecoder().decode(r).replace(/[\[\]\r\n]/g, '').trim();
      const p    = txt.split(/\s+/);
      if (p.length >= 12) {
        this.product  = p[0];
        this.serial   = p[1];
        this.uptime   = parseInt(p[2], 10);
        this.voltage  = parseFloat(p[3]);
        this.current  = parseFloat(p[4]);
        this.temp     = parseFloat(p[5]);
        this.mode     = p[6];
        this.sda      = parseInt(p[7], 10);   // note: sda before scl in the wire format
        this.scl      = parseInt(p[8], 10);
        this.speed    = parseInt(p[9], 10);
        this.pullups  = parseInt(p[10], 16);
        this.ccittCrc = parseInt(p[11], 16);
      }
      this._emit('status');
      return this;
    });
  }

  /** Set I²C bus speed. s must be 100 or 400 (kHz). */
  async setSpeed(s) {
    return this._enqueue(async () => {
      if (s !== 100 && s !== 400) throw new I2CDriverError('Ungültige Geschwindigkeit (100 oder 400 kHz)');
      await this._write(s === 400 ? 0x34 : 0x31); // '4' or '1'
      this.speed = s;
    });
  }

  /** Set pullup resistors. mask = 6-bit value. */
  async setPullups(mask) {
    return this._enqueue(async () => {
      const m = mask & 0x3F;
      await this._write([0x75, m]); // 'u'
      this.pullups = m;
    });
  }

  // ─── Bus Operations ──────────────────────────────────────────────────────────

  /** Scan the bus. Returns an array of detected 7-bit device addresses. */
  async scan() {
    return this._enqueue(async () => {
      await this._write(0x64); // 'd'
      const r = await this._read(112);
      return Array.from(r)
        .map((b, i) => b === 0x31 ? i + 8 : -1) // '1' = found, addresses start at 0x08
        .filter(a => a >= 0);
    });
  }

  /** Send I²C bus reset. Returns bus state (bit0=SCL, bit1=SDA). */
  async reset() {
    return this._enqueue(async () => {
      await this._write(0x78); // 'x'
      const r = await this._read(1);
      return r[0] & 3;
    });
  }

  /** Start an I²C transaction. dev = 7-bit address, rw = 0 (write) / 1 (read). */
  async start(dev, rw) {
    await this._write([0x73, (dev << 1) | (rw & 1)]); // 's'
    return this._ack();
  }

  /** Stop the current I²C transaction. */
  async stop() {
    await this._write(0x70); // 'p'
  }

  /** Read n bytes from the current transaction (NAK on last byte). */
  async readBytes(n) {
    const chunks  = [];
    let remaining = n;

    // Bulk reads of exactly 64 bytes (all ACK'd)
    if (remaining >= 64) {
      const bulkCount = Math.floor((remaining - 1) / 64);
      for (let i = 0; i < bulkCount; i++) {
        await this._write([0x61, 64]); // 'a', 64
        chunks.push(await this._read(64));
        remaining -= 64;
      }
    }

    // Remaining 1–64 bytes (last byte NAK'd)
    await this._write([0x80 + remaining - 1]);
    chunks.push(await this._read(remaining));

    const result = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let offset = 0;
    for (const c of chunks) { result.set(c, offset); offset += c.length; }
    return result;
  }

  /** Write bytes to the current transaction. Returns true if all bytes ACK'd. */
  async writeBytes(data) {
    if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
    let ack = true;
    for (let i = 0; i < data.length; i += 64) {
      const chunk = data.slice(i, i + 64);
      await this._write([0xC0 + chunk.length - 1]);
      await this._write(chunk);
      ack = await this._ack();
    }
    return ack;
  }

  // ─── High-level Helpers ───────────────────────────────────────────────────────

  /**
   * Read n bytes from register `reg` of device `dev`.
   * Uses the firmware shortcut ('r' command) for n ≤ 255.
   */
  async regRead(dev, reg, n = 1) {
    return this._enqueue(async () => {
      const count = Math.max(1, Math.min(n, 255));
      await this._write([0x72, dev & 0x7F, reg & 0xFF, count]); // 'r'
      return this._read(count);
    });
  }

  /**
   * Write data to register `reg` of device `dev`.
   * data can be a number (single byte), array, or Uint8Array.
   */
  async regWrite(dev, reg, data) {
    return this._enqueue(async () => {
      if (typeof data === 'number') data = new Uint8Array([data]);
      else if (Array.isArray(data)) data = new Uint8Array(data);
      const ack = await this.start(dev, 0);
      if (ack) {
        await this.writeBytes(new Uint8Array([reg & 0xFF]));
        await this.writeBytes(data);
      }
      await this.stop();
      return ack;
    });
  }

  /** Plain write transaction: start(dev,W) + write(data) + stop. */
  async write(dev, data) {
    return this._enqueue(async () => {
      if (typeof data === 'number') data = new Uint8Array([data]);
      else if (Array.isArray(data)) data = new Uint8Array(data);
      const ack = await this.start(dev, 0);
      if (ack) await this.writeBytes(data);
      await this.stop();
      return ack;
    });
  }

  /** Plain read transaction: start(dev,R) + read(n) + stop. */
  async read(dev, n) {
    return this._enqueue(async () => {
      const ack = await this.start(dev, 1);
      if (!ack) { await this.stop(); return null; }
      const data = await this.readBytes(n);
      await this.stop();
      return data;
    });
  }

  /**
   * Write-then-read with repeated START.
   * Useful for devices that require a register address written before reading.
   */
  async writeRead(dev, writeData, readLen) {
    return this._enqueue(async () => {
      if (typeof writeData === 'number') writeData = new Uint8Array([writeData]);
      else if (Array.isArray(writeData)) writeData = new Uint8Array(writeData);
      let ack = await this.start(dev, 0);
      if (!ack) { await this.stop(); return null; }
      ack = await this.writeBytes(writeData);
      if (!ack) { await this.stop(); return null; }
      ack = await this.start(dev, 1); // repeated START
      if (!ack) { await this.stop(); return null; }
      const data = await this.readBytes(readLen);
      await this.stop();
      return data;
    });
  }
}
