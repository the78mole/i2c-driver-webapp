import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import Chart from 'chart.js/auto';
import { I2CDriver } from './i2cdriver.js';

// ─── Register data-format helpers ─────────────────────────────────────────────

/** Number of bytes to read for a given format string */
function fmtByteCount(fmt) {
  const f = (fmt ?? 'u8').toLowerCase();
  if (f === 'u8' || f === 'i8') return 1;
  if (f === 'u16le' || f === 'u16be' || f === 'i16le' || f === 'i16be') return 2;
  if (f === 'u32le' || f === 'u32be' || f === 'i32le' || f === 'i32be') return 4;
  return 1;
}

/** Decode a Uint8Array into a numeric value according to format */
function decodeRegValue(data, fmt) {
  const f   = (fmt ?? 'u8').toLowerCase();
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const v   = new DataView(buf);
  switch (f) {
    case 'u8':    return v.getUint8(0);
    case 'i8':    return v.getInt8(0);
    case 'u16le': return v.getUint16(0, true);
    case 'u16be': return v.getUint16(0, false);
    case 'i16le': return v.getInt16(0, true);
    case 'i16be': return v.getInt16(0, false);
    case 'u32le': return v.getUint32(0, true);
    case 'u32be': return v.getUint32(0, false);
    case 'i32le': return v.getInt32(0, true);
    case 'i32be': return v.getInt32(0, false);
    default:      return v.getUint8(0);
  }
}

/** Format bytes as hex string e.g. "0x1A2B" */
function fmtHex(data) {
  return '0x' + [...data].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ─── Pullup resistor options ────────────────────────────────────────────────
// Bit mapping per signal (SDA: bits 2,1,0 – SCL: bits 5,4,3):
//   bit2/5 = 4.7 kΩ,  bit1/4 = 4.3 kΩ,  bit0/3 = 2.2 kΩ
// 3-bit value sorted high→low effective resistance
const PULLUP_OPTIONS = [
  { bits: 0b000, label: 'Aus (kein Pull-up)' },
  { bits: 0b100, label: '4,7 kΩ' },
  { bits: 0b010, label: '4,3 kΩ' },
  { bits: 0b110, label: '≈ 2,2 kΩ  (4,7k ∥ 4,3k)' },
  { bits: 0b001, label: '2,2 kΩ' },
  { bits: 0b101, label: '≈ 1,5 kΩ  (4,7k ∥ 2,2k)' },
  { bits: 0b011, label: '≈ 1,5 kΩ  (4,3k ∥ 2,2k)' },
  { bits: 0b111, label: '≈ 1,1 kΩ  (alle parallel)' },
];

// ─── Known I2C device addresses ───────────────────────────────────────────────
const KNOWN_DEVICES = {
  0x08: 'PCA9557', 0x09: 'PCA9557', 0x0A: 'PCA9557', 0x0B: 'PCA9557',
  0x18: 'MCP9808', 0x19: 'MCP9808', 0x1A: 'MCP9808', 0x1B: 'MCP9808',
  0x1C: 'MCP9808', 0x1D: 'MCP9808', 0x1E: 'MCP9808', 0x1F: 'MCP9808',
  0x20: 'PCF8574 / MCP23008', 0x21: 'PCF8574 / MCP23008',
  0x22: 'PCF8574 / MCP23008', 0x23: 'PCF8574 / MCP23008',
  0x24: 'PCF8574 / MCP23008', 0x25: 'PCF8574 / MCP23008',
  0x26: 'PCF8574 / MCP23008', 0x27: 'PCF8574 / MCP23008',
  0x28: 'BNO055',  0x29: 'VL53L0X / BNO055',
  0x3C: 'SSD1306 OLED', 0x3D: 'SSD1306 OLED',
  0x38: 'AHT10 / FT6336', 0x39: 'APDS9960 / TSL2561',
  0x40: 'INA219 / PCA9685', 0x41: 'INA219', 0x42: 'INA219', 0x43: 'INA219',
  0x44: 'SHT31 / ISL29125', 0x45: 'SHT31',
  0x48: 'ADS1115 / LM75', 0x49: 'ADS1115 / LM75',
  0x4A: 'ADS1115 / LM75', 0x4B: 'ADS1115 / LM75',
  0x4C: 'LM75', 0x4D: 'LM75', 0x4E: 'LM75', 0x4F: 'LM75',
  0x50: '24Cxx EEPROM', 0x51: '24Cxx EEPROM', 0x52: '24Cxx EEPROM',
  0x53: 'ADXL345 / 24Cxx', 0x54: '24Cxx EEPROM', 0x55: '24Cxx EEPROM',
  0x56: '24Cxx EEPROM', 0x57: '24Cxx EEPROM',
  0x5A: 'MPR121 / MLX90614', 0x5B: 'MPR121',
  0x60: 'MPL3115A2 / Si5351', 0x68: 'DS3231 / MPU-6050', 0x69: 'MPU-6050',
  0x6A: 'ICM-20600', 0x6B: 'ICM-20600',
  0x70: 'TCA9548A Mux', 0x71: 'TCA9548A Mux', 0x72: 'TCA9548A Mux',
  0x76: 'BME280 / BMP280', 0x77: 'BME280 / BMP280',
};

// ─── State ────────────────────────────────────────────────────────────────────
const drv = new I2CDriver();
let autoRefreshTimer = null;

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

/** Set inner HTML and optionally a class. */
function setResult(id, html, cls = '') {
  const el = $(id);
  el.innerHTML = html;
  el.className = 'result-hex' + (cls ? ' ' + cls : '');
}

/** Format Uint8Array as annotated hex spans. */
function formatBytes(data) {
  if (!data || data.length === 0) return '<em style="color:#555">–</em>';
  return Array.from(data).map(b => {
    const h  = b.toString(16).toUpperCase().padStart(2, '0');
    const d  = b.toString(10);
    const ch = (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
    return `<span class="byte-hex" title="dec:${d} chr:${ch}">0x${h}</span>`;
  }).join(' ');
}

/** Parse a hex string like "0x12 34 0xAB" → Uint8Array */
function parseHex(str) {
  const tokens = str.trim().split(/[\s,]+/).filter(Boolean);
  const bytes = tokens.map(t => {
    const v = parseInt(t, 16);
    if (isNaN(v) || v < 0 || v > 255) throw new Error(`Ungültiger Hex-Wert: "${t}"`);
    return v;
  });
  return new Uint8Array(bytes);
}

/** Parse a hex address string (e.g. "0x48" or "72") → number */
function parseAddr(str) {
  const v = parseInt(str.trim(), str.trim().startsWith('0x') ? 16 : 16);
  if (isNaN(v) || v < 0 || v > 127) throw new Error(`Ungültige I²C-Adresse: "${str}" (0x00–0x7F)`);
  return v;
}

/** Format uptime seconds → "Xh Ym Zs" */
function fmtUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h > 0 ? h + 'h ' : ''}${m > 0 ? m + 'm ' : ''}${sec}s`;
}

/** Copy inner text of result element to clipboard. */
function copyResult(id) {
  const el = $(id);
  if (!el) return;
  const text = el.innerText || el.textContent;
  navigator.clipboard.writeText(text).catch(() => {});
}

// ─── xterm.js terminal (log) ───────────────────────────────────────────────────────────────────
const term = new Terminal({
  theme: {
    background:   '#080813',
    foreground:   '#dde1f0',
    black:        '#1a1a38',
    red:          '#ff4444',
    green:        '#00e676',
    yellow:       '#ffab00',
    blue:         '#00d4ff',
    magenta:      '#b57bee',
    cyan:         '#00d4ff',
    white:        '#dde1f0',
    brightBlack:  '#555870',
    brightRed:    '#ff6b6b',
    brightGreen:  '#69ff9f',
    brightYellow: '#ffd740',
    brightBlue:   '#80e9ff',
    brightMagenta:'#d0b0ff',
    brightCyan:   '#80e9ff',
    brightWhite:  '#ffffff',
  },
  fontFamily:   '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
  fontSize:     12,
  lineHeight:   1.4,
  cursorStyle:  'bar',
  cursorBlink:  false,
  convertEol:   true,
  scrollback:   500,
  disableStdin: true,
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

// ANSI color helpers
const A = {
  reset: '\x1b[0m',
  dim:   '\x1b[2m',
  INFO:  '\x1b[38;5;246m',  // medium gray
  TX:    '\x1b[38;5;45m',   // bright cyan
  RX:    '\x1b[38;5;83m',   // bright green
  WARN:  '\x1b[38;5;214m',  // orange
  ERROR: '\x1b[38;5;196m',  // bright red
};

function log(tag, msg) {
  const now = new Date();
  const ts  = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const col = A[tag] ?? A.INFO;
  // Escape HTML entities that could interfere (xterm gets raw strings)
  term.writeln(`${A.dim}${ts}${A.reset} ${col}[${tag.padEnd(5)}]${A.reset} ${msg}`);
}

// ─── Status display ───────────────────────────────────────────────────────────
function updateStatus() {
  const d = drv;
  $('s-product').textContent = d.product  || '–';
  $('s-serial').textContent  = d.serial   || '–';
  $('s-uptime').textContent  = d.uptime   ? fmtUptime(d.uptime) : '–';
  $('s-voltage').textContent = d.voltage  ? d.voltage.toFixed(2) + ' V' : '–';
  $('s-current').textContent = d.current  !== undefined ? d.current.toFixed(1) + ' mA' : '–';
  $('s-temp').textContent    = d.temp     ? d.temp.toFixed(1) + ' °C' : '–';
  $('s-mode').textContent    = d.mode     || '–';
  $('s-speed').textContent   = d.speed    ? d.speed + ' kHz' : '–';

  const sclEl = $('s-scl');
  const sdaEl = $('s-sda');
  sclEl.textContent  = d.scl !== undefined ? (d.scl ? 'HIGH' : 'LOW') : '–';
  sdaEl.textContent  = d.sda !== undefined ? (d.sda ? 'HIGH' : 'LOW') : '–';
  sclEl.className = 'val ' + (d.scl ? 'pin-high' : 'pin-low');
  sdaEl.className = 'val ' + (d.sda ? 'pin-high' : 'pin-low');

  // Sync speed radio buttons
  document.querySelectorAll('input[name="speed"]').forEach(r => {
    r.checked = parseInt(r.value) === d.speed;
  });

  // Sync pullup selects
  $('pullup-sda').value = String(d.pullups & 0x07);
  $('pullup-scl').value = String((d.pullups >> 3) & 0x07);
}

// ─── Scan table ───────────────────────────────────────────────────────────────
function buildScanTable() {
  const tbody = $('scan-tbody');
  tbody.innerHTML = '';
  for (let row = 0; row < 8; row++) {
    const tr = document.createElement('tr');
    const baseAddr = row * 16;
    const th = document.createElement('th');
    th.textContent = '0x' + baseAddr.toString(16).toUpperCase().padStart(2, '0');
    tr.appendChild(th);
    for (let col = 0; col < 16; col++) {
      const addr = baseAddr + col;
      const td = document.createElement('td');
      td.id = `addr-${addr}`;
      // I2C addresses 0x00–0x07 and 0x78–0x7F are reserved
      if (addr < 8 || addr > 119) {
        td.className = 'addr-cell reserved';
        td.textContent = addr.toString(16).toUpperCase().padStart(2, '0');
      } else {
        td.className = 'addr-cell';
        td.textContent = addr.toString(16).toUpperCase().padStart(2, '0');
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function applyScanResult(foundAddresses) {
  // Reset all scannable cells
  for (let addr = 8; addr <= 119; addr++) {
    const td = $(`addr-${addr}`);
    if (td) td.className = 'addr-cell';
  }

  // Highlight found devices
  for (const addr of foundAddresses) {
    const td = $(`addr-${addr}`);
    if (td) {
      const name = KNOWN_DEVICES[addr] || '';
      td.className = 'addr-cell found';
      if (name) td.title = name;

      // Click handler: fill I2C op fields with this address
      td.onclick = () => {
        const hexAddr = '0x' + addr.toString(16).toUpperCase().padStart(2, '0');
        ['regrd-dev','regwr-dev','write-dev','read-dev','wr-dev'].forEach(id => {
          const el = $(id);
          if (el) el.value = hexAddr;
        });
        // Switch to ops card
        $('card-ops').scrollIntoView({ behavior: 'smooth', block: 'start' });
        log('INFO', `Adresse ${hexAddr} in Operationsfelder übernommen`);
      };
    }
  }

  // Summary
  const summaryEl = $('scan-summary');
  if (foundAddresses.length === 0) {
    summaryEl.innerHTML = 'Keine Geräte gefunden.';
  } else {
    const addrs = foundAddresses.map(a =>
      '0x' + a.toString(16).toUpperCase().padStart(2, '0')
    ).join(', ');
    summaryEl.innerHTML =
      `<span class="found-count">${foundAddresses.length} Gerät${foundAddresses.length > 1 ? 'e' : ''}</span>` +
      ` gefunden: ${addrs}`;
  }

  // Device badges
  const badgesEl = $('device-info-badges');
  badgesEl.innerHTML = '';
  for (const addr of foundAddresses) {
    const name = KNOWN_DEVICES[addr];
    const hexAddr = '0x' + addr.toString(16).toUpperCase().padStart(2, '0');
    const badge = document.createElement('span');
    badge.className = 'device-badge';
    badge.innerHTML = `<span class="addr">${hexAddr}</span>` +
      (name ? `<span class="name">${name}</span>` : '<span class="name">Unbekannt</span>');
    badgesEl.appendChild(badge);
  }
}

// ─── Enable / disable controls ────────────────────────────────────────────────
function setConnected(connected) {
  const dot   = $('conn-dot');
  const label = $('conn-label');

  dot.className   = 'dot ' + (connected ? 'connected' : 'disconnected');
  label.textContent = connected
    ? (drv.product || 'Verbunden')
    : 'Nicht verbunden';

  $('btn-connect').classList.toggle('hidden', connected);
  $('btn-disconnect').classList.toggle('hidden', !connected);

  // Enable/disable all action buttons
  const actionBtns = [
    'btn-refresh', 'btn-set-speed', 'btn-set-pullups', 'btn-bus-reset',
    'btn-scan', 'btn-regrd', 'btn-regwr', 'btn-write', 'btn-read', 'btn-writeread',
    // btn-dev-read-all is managed by initDeviceExplorer (only when a device is selected)
  ];
  actionBtns.forEach(id => {
    const el = $(id);
    if (el) el.disabled = !connected;
  });
  $('pullup-sda').disabled = !connected;
  $('pullup-scl').disabled = !connected;
  document.querySelectorAll('input[name="speed"]').forEach(r => r.disabled = !connected);
}

// ─── Auto-refresh ─────────────────────────────────────────────────────────────
function startAutoRefresh() {
  if (autoRefreshTimer) return;
  autoRefreshTimer = setInterval(async () => {
    if (!drv.connected) { stopAutoRefresh(); return; }
    try { await drv.getStatus(); } catch (e) {}
  }, 5000);
}

function stopAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
}

// ─── Error handler ────────────────────────────────────────────────────────────
function handleError(e, context = '') {
  const msg = (context ? context + ': ' : '') + (e.message || e);
  log('ERROR', msg);
  console.error(e);
}

// ─── Wrap async ops with loading state ───────────────────────────────────────
async function withBusy(btnId, fn) {
  const btn = $(btnId);
  if (btn) { btn.disabled = true; btn.textContent += ' …'; }
  try {
    await fn();
  } catch (e) {
    handleError(e);
  } finally {
    if (btn) {
      btn.disabled = !drv.connected;
      // Restore original text (strip ' …')
      btn.textContent = btn.textContent.replace(' …', '');
    }
  }
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
document.getElementById('ops-tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  $(btn.dataset.tab).classList.add('active');
});

// ─── Connect / Disconnect ─────────────────────────────────────────────────────
$('btn-connect').addEventListener('click', async () => {
  const btn = $('btn-connect');
  const dot = $('conn-dot');
  btn.disabled = true;
  dot.className = 'dot connecting';
  $('conn-label').textContent = 'Verbinde …';

  try {
    await drv.connect();
    log('INFO', `Verbunden mit ${drv.product} (SN: ${drv.serial})`);
  } catch (e) {
    handleError(e, 'Verbindung fehlgeschlagen');
    btn.disabled = false;
    dot.className = 'dot disconnected';
    $('conn-label').textContent = 'Nicht verbunden';
  }
});

$('btn-disconnect').addEventListener('click', async () => {
  try {
    await drv.disconnect();
  } catch (e) {
    handleError(e, 'Trennen fehlgeschlagen');
  }
});

// ─── Driver events ────────────────────────────────────────────────────────────
drv.addEventListener('connected', () => {
  setConnected(true);
  updateStatus();
  if ($('auto-refresh').checked) startAutoRefresh();
  log('INFO', `Verbunden: ${drv.product}, SN=${drv.serial}, ${drv.speed} kHz, ${drv.voltage.toFixed(2)} V`);
});

drv.addEventListener('disconnected', () => {
  stopAutoRefresh();
  setConnected(false);
  log('INFO', 'Verbindung getrennt');
});

drv.addEventListener('status', () => {
  updateStatus();
});

// ─── Status / Refresh ─────────────────────────────────────────────────────────
$('btn-refresh').addEventListener('click', () =>
  withBusy('btn-refresh', async () => {
    await drv.getStatus();
    log('INFO', `Status: ${drv.voltage.toFixed(2)} V, ${drv.current.toFixed(1)} mA, ${drv.temp.toFixed(1)} °C`);
  })
);

$('auto-refresh').addEventListener('change', e => {
  if (e.target.checked && drv.connected) startAutoRefresh();
  else stopAutoRefresh();
});

// ─── Settings ─────────────────────────────────────────────────────────────────
$('btn-set-speed').addEventListener('click', () =>
  withBusy('btn-set-speed', async () => {
    const val = parseInt(document.querySelector('input[name="speed"]:checked').value);
    await drv.setSpeed(val);
    log('TX', `Geschwindigkeit gesetzt: ${val} kHz`);
  })
);

$('btn-set-pullups').addEventListener('click', () =>
  withBusy('btn-set-pullups', async () => {
    const sdaVal = parseInt($('pullup-sda').value);
    const sclVal = parseInt($('pullup-scl').value);
    const mask   = (sclVal << 3) | sdaVal;
    await drv.setPullups(mask);
    const sdaLabel = PULLUP_OPTIONS.find(o => o.bits === sdaVal)?.label ?? sdaVal;
    const sclLabel = PULLUP_OPTIONS.find(o => o.bits === sclVal)?.label ?? sclVal;
    log('TX', `Pullups → SDA: ${sdaLabel}, SCL: ${sclLabel}  (0b${mask.toString(2).padStart(6, '0')})`);
  })
);

$('btn-bus-reset').addEventListener('click', () =>
  withBusy('btn-bus-reset', async () => {
    const state = await drv.reset();
    const scl = (state & 1) ? 'HIGH' : 'LOW';
    const sda = (state & 2) ? 'HIGH' : 'LOW';
    log('TX', `Bus-Reset → SCL=${scl}, SDA=${sda}`);
    await drv.getStatus();
  })
);

// ─── Bus Scan ─────────────────────────────────────────────────────────────────
$('btn-scan').addEventListener('click', () =>
  withBusy('btn-scan', async () => {
    log('TX', 'Bus-Scan gestartet …');
    $('scan-summary').textContent = 'Scanning …';
    const found = await drv.scan();
    applyScanResult(found);
    const names = found.map(a => {
      const hex = '0x' + a.toString(16).toUpperCase().padStart(2,'0');
      const name = KNOWN_DEVICES[a] ? ` (${KNOWN_DEVICES[a]})` : '';
      return hex + name;
    });
    log('RX', `Scan abgeschlossen – ${found.length} Gerät(e): ${names.join(', ') || '–'}`);
  })
);

// ─── Register Read ────────────────────────────────────────────────────────────
$('btn-regrd').addEventListener('click', () =>
  withBusy('btn-regrd', async () => {
    const dev = parseAddr($('regrd-dev').value);
    const reg = parseInt($('regrd-reg').value.trim(), 16);
    const len = Math.max(1, Math.min(255, parseInt($('regrd-len').value)));
    if (isNaN(reg)) throw new Error('Ungültige Registeradresse');

    const devHex = '0x' + dev.toString(16).toUpperCase().padStart(2,'0');
    const regHex = '0x' + reg.toString(16).toUpperCase().padStart(2,'0');

    log('TX', `REG READ  dev=${devHex} reg=${regHex} n=${len}`);
    const data = await drv.regRead(dev, reg, len);
    setResult('regrd-result', formatBytes(data));
    const hex = Array.from(data).map(b => '0x' + b.toString(16).padStart(2,'0')).join(' ');
    log('RX', `← ${hex}`);
  })
);

// ─── Register Write ───────────────────────────────────────────────────────────
$('btn-regwr').addEventListener('click', () =>
  withBusy('btn-regwr', async () => {
    const dev  = parseAddr($('regwr-dev').value);
    const reg  = parseInt($('regwr-reg').value.trim(), 16);
    const data = parseHex($('regwr-data').value);
    if (isNaN(reg)) throw new Error('Ungültige Registeradresse');
    if (data.length === 0) throw new Error('Keine Daten eingegeben');

    const devHex  = '0x' + dev.toString(16).toUpperCase().padStart(2,'0');
    const regHex  = '0x' + reg.toString(16).toUpperCase().padStart(2,'0');
    const dataHex = Array.from(data).map(b => '0x'+b.toString(16).padStart(2,'0')).join(' ');

    log('TX', `REG WRITE dev=${devHex} reg=${regHex} data=${dataHex}`);
    const ack = await drv.regWrite(dev, reg, data);
    const html = ack
      ? '<span class="result-ack">ACK ✓</span>'
      : '<span class="result-nack">NACK ✗ (Gerät nicht gefunden?)</span>';
    setResult('regwr-result', html);
    log(ack ? 'RX' : 'WARN', ack ? '← ACK' : '← NACK');
  })
);

// ─── Plain Write ──────────────────────────────────────────────────────────────
$('btn-write').addEventListener('click', () =>
  withBusy('btn-write', async () => {
    const dev  = parseAddr($('write-dev').value);
    const data = parseHex($('write-data').value);
    if (data.length === 0) throw new Error('Keine Daten eingegeben');

    const devHex  = '0x' + dev.toString(16).toUpperCase().padStart(2,'0');
    const dataHex = Array.from(data).map(b => '0x'+b.toString(16).padStart(2,'0')).join(' ');

    log('TX', `WRITE dev=${devHex} → ${dataHex}`);
    const ack = await drv.write(dev, data);
    const html = ack
      ? '<span class="result-ack">ACK ✓</span>'
      : '<span class="result-nack">NACK ✗ (Gerät nicht gefunden?)</span>';
    setResult('write-result', html);
    log(ack ? 'RX' : 'WARN', ack ? '← ACK' : '← NACK');
  })
);

// ─── Plain Read ───────────────────────────────────────────────────────────────
$('btn-read').addEventListener('click', () =>
  withBusy('btn-read', async () => {
    const dev = parseAddr($('read-dev').value);
    const len = Math.max(1, parseInt($('read-len').value));

    const devHex = '0x' + dev.toString(16).toUpperCase().padStart(2,'0');
    log('TX', `READ dev=${devHex} n=${len}`);
    const data = await drv.read(dev, len);
    if (!data) {
      setResult('read-result', '<span class="result-nack">NACK ✗ (Gerät nicht gefunden?)</span>');
      log('WARN', '← NACK');
      return;
    }
    setResult('read-result', formatBytes(data));
    const hex = Array.from(data).map(b => '0x' + b.toString(16).padStart(2,'0')).join(' ');
    log('RX', `← ${hex}`);
  })
);

// ─── Write + Read ─────────────────────────────────────────────────────────────
$('btn-writeread').addEventListener('click', () =>
  withBusy('btn-writeread', async () => {
    const dev       = parseAddr($('wr-dev').value);
    const writeData = parseHex($('wr-write-data').value);
    const readLen   = Math.max(1, parseInt($('wr-read-len').value));
    if (writeData.length === 0) throw new Error('Keine Sendedaten eingegeben');

    const devHex  = '0x' + dev.toString(16).toUpperCase().padStart(2,'0');
    const txHex   = Array.from(writeData).map(b => '0x'+b.toString(16).padStart(2,'0')).join(' ');
    log('TX', `WRITE+READ dev=${devHex} tx=${txHex} rx=${readLen} Bytes`);

    const data = await drv.writeRead(dev, writeData, readLen);
    if (!data) {
      setResult('wr-result', '<span class="result-nack">NACK ✗ (Gerät nicht gefunden?)</span>');
      log('WARN', '← NACK');
      return;
    }
    setResult('wr-result', formatBytes(data));
    const hex = Array.from(data).map(b => '0x' + b.toString(16).padStart(2,'0')).join(' ');
    log('RX', `← ${hex}`);
  })
);

// ─── Log controls ─────────────────────────────────────────────────────────────
$('btn-clear-log').addEventListener('click', () => term.clear());

// ─── Device Explorer ──────────────────────────────────────────────────────────

// Load all device JSON files via Vite glob (relative to app.js)
const deviceModules = import.meta.glob('./devices/*.json', { eager: true });
const DEVICES = Object.values(deviceModules)
  .map(m => m.default ?? m)
  .sort((a, b) => a.device.localeCompare(b.device));

function initDeviceExplorer() {
  const devSelect  = $('dev-select');
  const addrSelect = $('dev-addr-select');
  const btnReadAll = $('btn-dev-read-all');
  const regTbody   = $('dev-reg-tbody');
  const regWrap    = $('dev-reg-table-wrap');
  const descEl     = $('dev-description');
  const pollBar    = $('dev-poll-bar');
  const slider     = $('poll-slider');
  const numInput   = $('poll-rate-num');
  const unitSel    = $('poll-unit');
  const rateLabel  = $('poll-rate-label');
  const btnStart   = $('btn-poll-start');
  const btnStop    = $('btn-poll-stop');
  const counter    = $('poll-counter');
  const chartWrap   = $('poll-chart-wrap');
  const scriptsBar  = $('dev-scripts-bar');
  const scriptsList = $('dev-scripts-list');

  // ── Polling state ──────────────────────────────────────────────────────────
  let pollTimer  = null;
  let pollCount  = 0;
  let pollRunFn  = null;
  let pollChart  = null;
  let pollStart  = 0;

  // ── Chart palette (dark-theme contrasting colors) ──────────────────────────
  const PALETTE = ['#00d6ff','#ff6b6b','#06d6a0','#ffd166','#a29bfe','#fd79a8','#74b9ff','#55efc4'];

  // ── Populate device dropdown ───────────────────────────────────────────────
  DEVICES.forEach((dev, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${dev.device} – ${dev.description}`;
    devSelect.appendChild(opt);
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function accessClass(access) {
    if (access === 'R') return 'access-R';
    if (access === 'W') return 'access-W';
    return 'access-RW';
  }

  function getPollIntervalMs() {
    const val = Math.max(1, parseInt(numInput.value, 10) || 500);
    return unitSel.value === 's' ? val * 1000 : val;
  }

  function syncPollDisplay() {
    const ms = getPollIntervalMs();
    rateLabel.textContent = ms >= 2000
      ? `→ ${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s`
      : `→ ${ms} ms`;
  }

  function updatePollStartBtn() {
    const anyChecked = regTbody.querySelector('.poll-cb:checked') !== null;
    btnStart.disabled = !drv.connected || !anyChecked || pollTimer !== null;
  }

  // ── Register table ─────────────────────────────────────────────────────────
  function buildRegTable(dev) {
    regTbody.innerHTML = '';
    dev.registers.forEach(reg => {
      const isRead  = reg.access.includes('R');
      const isWrite = reg.access.includes('W');
      const regId   = reg.address.replace(/0x/i, '');
      const fmt     = reg.format ?? 'u8';

      const bitsHtml = (reg.bits ?? []).map(b => `
        <div class="bit-row">
          <span class="bit-pos">[${b.position}]</span>
          <span class="bit-name">${b.name}</span>
          <span class="bit-desc">${b.description}</span>
        </div>`).join('');

      const tr = document.createElement('tr');
      tr.dataset.regAddr = reg.address;
      tr.innerHTML = `
        <td class="poll-col">
          ${isRead ? `<input type="checkbox" class="poll-cb"
            data-addr="${reg.address}"
            data-fmt="${fmt}"
            data-name="${reg.name}"
            title="In Polling aufnehmen">` : ''}
        </td>
        <td class="mono">${reg.address}</td>
        <td>
          <details>
            <summary>
              <strong>${reg.name}</strong>
              <span class="reg-desc text-dim">${reg.description}</span>
            </summary>
            ${bitsHtml ? `<div class="bit-table">${bitsHtml}</div>` : ''}
          </details>
        </td>
        <td><span class="access-badge ${accessClass(reg.access)}">${reg.access}</span></td>
        <td class="mono">${reg.reset_value}</td>
        <td class="mono fmt-badge">${fmt}</td>
        <td class="mono reg-val" id="regval-${regId}">–</td>
        <td class="reg-actions">
          ${isRead  ? `<button class="btn btn-xs btn-secondary btn-reg-read" data-addr="${reg.address}" data-fmt="${fmt}">Lesen</button>` : ''}
          ${isWrite ? `<div class="reg-write-group">
            <input class="reg-write-input" type="text" placeholder="0x00" maxlength="10" data-addr="${reg.address}">
            <button class="btn btn-xs btn-warning btn-reg-write" data-addr="${reg.address}">Schreiben</button>
          </div>` : ''}
        </td>`;
      regTbody.appendChild(tr);
    });
  }

  async function readOneRegister(regAddr, fmt = 'u8') {
    const devAddr  = parseInt(addrSelect.value, 16);
    const regByte  = parseInt(regAddr, 16);
    const nBytes   = fmtByteCount(fmt);
    const data     = await drv.regRead(devAddr, regByte, nBytes);
    const numVal   = decodeRegValue(data, fmt);
    const hexStr   = fmtHex(data);
    const dispStr  = nBytes === 1 ? hexStr : String(numVal);

    const valEl = document.getElementById('regval-' + regAddr.replace(/0x/i, ''));
    if (valEl) {
      valEl.textContent = dispStr;
      valEl.title = nBytes > 1 ? `hex: ${hexStr}` : '';
      valEl.classList.remove('flash');
      void valEl.offsetWidth; // force reflow for animation restart
      valEl.classList.add('flash');
    }
    return { numVal, hexStr, dispStr };
  }

  // ── Chart ──────────────────────────────────────────────────────────────────
  const CHART_MAX_PTS = 120;

  function initPollChart(regInfos) {
    chartWrap.classList.remove('hidden');
    if (pollChart) { pollChart.destroy(); pollChart = null; }

    const datasets = regInfos.map((ri, i) => ({
      label: `${ri.name} (${ri.addr}) [${ri.fmt}]`,
      data: [],
      borderColor: PALETTE[i % PALETTE.length],
      backgroundColor: PALETTE[i % PALETTE.length] + '22',
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 3,
      tension: 0.25,
      fill: false,
    }));

    pollChart = new Chart($('poll-chart'), {
      type: 'line',
      data: { labels: [], datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            ticks: { color: '#8b98a5', maxTicksLimit: 8, maxRotation: 0 },
            grid:  { color: '#253040' },
            title: { display: true, text: 'Zeit (s)', color: '#8b98a5', font: { size: 11 } },
          },
          y: {
            ticks: { color: '#8b98a5' },
            grid:  { color: '#253040' },
          },
        },
        plugins: {
          legend: { labels: { color: '#c0cdd6', boxWidth: 12, font: { size: 11 } } },
          tooltip: { backgroundColor: '#1a2530', titleColor: '#c0cdd6', bodyColor: '#8b98a5' },
        },
      },
    });
  }

  function pushChartValues(timeSec, values) {
    if (!pollChart) return;
    const d = pollChart.data;
    if (d.labels.length >= CHART_MAX_PTS) {
      d.labels.shift();
      d.datasets.forEach(ds => ds.data.shift());
    }
    d.labels.push(timeSec);
    values.forEach((v, i) => { if (d.datasets[i]) d.datasets[i].data.push(v); });
    pollChart.update('none');
  }

  function destroyChart() {
    if (pollChart) { pollChart.destroy(); pollChart = null; }
    chartWrap.classList.add('hidden');
  }

  // ── Script runner ──────────────────────────────────────────────────────────
  function buildScriptButtons(dev) {
    scriptsList.innerHTML = '';
    const scripts = dev.scripts ?? [];
    if (!scripts.length) {
      scriptsBar.classList.add('hidden');
      return;
    }
    scripts.forEach(script => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary btn-script';
      btn.disabled = !drv.connected;
      btn.title = script.description ?? script.name;
      btn.textContent = script.name;
      btn.addEventListener('click', async () => {
        const allBtns = scriptsList.querySelectorAll('.btn-script');
        allBtns.forEach(b => { b.disabled = true; });
        const origText = btn.textContent;
        btn.textContent = `${script.name} …`;
        try {
          await runScript(script);
        } catch (e) {
          handleError(e, `Skript "${script.name}"`);
        } finally {
          btn.textContent = origText;
          allBtns.forEach(b => { b.disabled = !drv.connected; });
        }
      });
      scriptsList.appendChild(btn);
    });
    scriptsBar.classList.remove('hidden');
  }

  async function runScript(script) {
    const devAddr = parseInt(addrSelect.value, 16);
    log('INFO', `▶ Skript starten: ${script.name}`);
    for (const cmd of script.commands) {
      const comment = cmd.comment ? ` — ${cmd.comment}` : '';
      if (cmd.op === 'delay') {
        await new Promise(r => setTimeout(r, cmd.ms ?? 10));
        log('INFO', `  ⏱ ${cmd.ms} ms Pause${comment}`);
        continue;
      }
      const regByte = parseInt(cmd.reg, 16);
      if (cmd.op === 'write') {
        const bytes = new Uint8Array((cmd.data ?? []).map(b => parseInt(b, 16)));
        await drv.regWrite(devAddr, regByte, bytes);
        log('TX', `  ${cmd.reg} ← ${(cmd.data ?? []).join(' ')}${comment}`);
      } else if (cmd.op === 'read') {
        const fmt = cmd.format ?? 'u8';
        const { dispStr, hexStr } = await readOneRegister(cmd.reg, fmt);
        const display = fmtByteCount(fmt) > 1 ? `${dispStr} (${hexStr})` : dispStr;
        log('RX', `  ${cmd.reg} [${fmt}] = ${display}${comment}`);
      } else if (cmd.op === 'poll_until') {
        const fmt      = cmd.format    ?? 'u8';
        const maxTries = cmd.max_tries ?? 10;
        const delayMs  = cmd.delay_ms  ?? 100;
        // expected kann Hex-String ("0xE5") oder Dezimalzahl sein
        const expected = typeof cmd.expected === 'number'
          ? cmd.expected
          : /^0x/i.test(String(cmd.expected))
            ? parseInt(cmd.expected, 16)
            : parseInt(cmd.expected, 10);

        let matched = false;
        for (let attempt = 1; attempt <= maxTries; attempt++) {
          const { numVal, dispStr, hexStr } = await readOneRegister(cmd.reg, fmt);
          const display = fmtByteCount(fmt) > 1 ? `${dispStr} (${hexStr})` : dispStr;
          const ok = numVal === expected;
          const triesStr = maxTries > 1 ? ` (${attempt}/${maxTries})` : '';
          const expectHex = '0x' + expected.toString(16).toUpperCase().padStart(2, '0');
          log(
            ok ? 'RX' : 'WARN',
            `  ${cmd.reg} [${fmt}] = ${display}${triesStr}` +
            (ok ? ` ✓${comment}` : ` – erwartet ${expectHex}${comment}`),
          );
          if (ok) { matched = true; break; }
          if (attempt < maxTries && delayMs > 0) {
            await new Promise(r => setTimeout(r, delayMs));
          }
        }
        if (!matched) {
          const expectHex = '0x' + expected.toString(16).toUpperCase().padStart(2, '0');
          throw new Error(
            `Register ${cmd.reg} hat nach ${maxTries} Versuch(en) nicht den erwarteten Wert ${expectHex} angenommen`
          );
        }
      }
    }
    log('INFO', `✓ Skript abgeschlossen: ${script.name}`);
  }

  // ── Poll rate controls ─────────────────────────────────────────────────────
  slider.addEventListener('input', () => {
    numInput.value = slider.value;
    syncPollDisplay();
    if (pollTimer && pollRunFn) {
      clearInterval(pollTimer);
      pollTimer = setInterval(pollRunFn, getPollIntervalMs());
    }
  });

  numInput.addEventListener('input', () => {
    slider.value = Math.min(1000, Math.max(1, numInput.value));
    syncPollDisplay();
    if (pollTimer && pollRunFn) {
      clearInterval(pollTimer);
      pollTimer = setInterval(pollRunFn, getPollIntervalMs());
    }
  });

  unitSel.addEventListener('change', () => {
    syncPollDisplay();
    if (pollTimer && pollRunFn) {
      clearInterval(pollTimer);
      pollTimer = setInterval(pollRunFn, getPollIntervalMs());
    }
  });

  // ── Poll checkbox – master / individual ────────────────────────────────────
  $('poll-all-cb').addEventListener('change', e => {
    regTbody.querySelectorAll('.poll-cb').forEach(cb => { cb.checked = e.target.checked; });
    updatePollStartBtn();
  });

  regTbody.addEventListener('change', e => {
    if (!e.target.classList.contains('poll-cb')) return;
    const all = [...regTbody.querySelectorAll('.poll-cb')];
    const chk = all.filter(c => c.checked);
    const masterCb = $('poll-all-cb');
    masterCb.indeterminate = chk.length > 0 && chk.length < all.length;
    masterCb.checked       = all.length > 0 && chk.length === all.length;
    updatePollStartBtn();
  });

  // ── Start / Stop polling ───────────────────────────────────────────────────
  function startPolling() {
    if (pollTimer) return;
    const regInfos = [...regTbody.querySelectorAll('.poll-cb:checked')].map(cb => ({
      addr: cb.dataset.addr,
      fmt:  cb.dataset.fmt || 'u8',
      name: cb.dataset.name || cb.dataset.addr,
    }));
    if (!regInfos.length) return;

    pollCount = 0;
    pollStart = Date.now();
    btnStart.classList.add('hidden');
    btnStop.classList.remove('hidden');
    counter.classList.remove('hidden');
    counter.textContent = '0×';

    initPollChart(regInfos);

    pollRunFn = async () => {
      const elapsed = ((Date.now() - pollStart) / 1000).toFixed(2);
      const values  = [];
      for (const ri of regInfos) {
        if (!drv.connected) { stopPolling(); return; }
        try {
          const { numVal } = await readOneRegister(ri.addr, ri.fmt);
          values.push(numVal);
        } catch { values.push(null); }
      }
      pushChartValues(elapsed, values);
      counter.textContent = `${++pollCount}×`;
    };

    pollRunFn();                                          // immediate first poll
    pollTimer = setInterval(pollRunFn, getPollIntervalMs());
    log('INFO', `Polling gestartet: ${regInfos.length} Register alle ${getPollIntervalMs()} ms`);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
    pollRunFn = null;
    btnStart.classList.remove('hidden');
    btnStop.classList.add('hidden');
    counter.textContent += ' (gestoppt)';
    log('INFO', `Polling gestoppt nach ${pollCount} Abfragen.`);
    updatePollStartBtn();
  }

  btnStart.addEventListener('click', startPolling);
  btnStop.addEventListener('click',  stopPolling);

  // ── Device selection ───────────────────────────────────────────────────────
  function onDeviceChange() {
    stopPolling();
    destroyChart();

    const idx = devSelect.value;
    addrSelect.innerHTML = '';
    addrSelect.disabled  = true;
    regTbody.innerHTML   = '';
    regWrap.classList.add('hidden');
    pollBar.classList.add('hidden');
    descEl.classList.add('hidden');
    counter.classList.add('hidden');
    scriptsBar.classList.add('hidden');
    btnReadAll.disabled = true;

    const masterCb = $('poll-all-cb');
    masterCb.checked       = false;
    masterCb.indeterminate = false;

    if (!idx) return;
    const dev = DEVICES[idx];

    dev.i2c_addresses.forEach(addr => {
      const opt = document.createElement('option');
      opt.value = addr;
      opt.textContent = addr;
      addrSelect.appendChild(opt);
    });
    addrSelect.disabled = false;

    descEl.textContent = `${dev.device}: ${dev.description}`;
    descEl.classList.remove('hidden');

    buildRegTable(dev);
    regWrap.classList.remove('hidden');
    pollBar.classList.remove('hidden');
    syncPollDisplay();
    btnReadAll.disabled = !drv.connected;
    updatePollStartBtn();
    buildScriptButtons(dev);
  }

  devSelect.addEventListener('change', onDeviceChange);

  // ── "Alle lesen" ───────────────────────────────────────────────────────────
  btnReadAll.addEventListener('click', () =>
    withBusy('btn-dev-read-all', async () => {
      const idx = devSelect.value;
      if (!idx) return;
      const dev = DEVICES[idx];
      for (const reg of dev.registers.filter(r => r.access.includes('R'))) {
        const fmt = reg.format ?? 'u8';
        try {
          const { dispStr, hexStr } = await readOneRegister(reg.address, fmt);
          const display = fmtByteCount(fmt) > 1 ? `${dispStr} (${hexStr})` : dispStr;
          log('RX', `${dev.device} ${reg.name} (${reg.address}) = ${display}`);
        } catch (e) {
          log('WARN', `${reg.name} (${reg.address}) Lesefehler: ${e.message}`);
        }
      }
    })
  );

  // ── Per-register read / write ──────────────────────────────────────────────
  regTbody.addEventListener('click', async e => {
    if (e.target.classList.contains('btn-reg-read')) {
      const addr = e.target.dataset.addr;
      const fmt  = e.target.dataset.fmt || 'u8';
      try {
        const { dispStr, hexStr } = await readOneRegister(addr, fmt);
        const display = fmtByteCount(fmt) > 1 ? `${dispStr} (${hexStr})` : dispStr;
        log('RX', `Reg ${addr} [${fmt}] = ${display}`);
      } catch (err) { handleError(err, `Reg lesen ${addr}`); }
    }

    if (e.target.classList.contains('btn-reg-write')) {
      const addr  = e.target.dataset.addr;
      const input = regTbody.querySelector(`.reg-write-input[data-addr="${addr}"]`);
      const bytes = parseHex(input?.value ?? '');
      if (!bytes || bytes.length === 0) { log('WARN', 'Ungültiger Schreibwert'); return; }
      try {
        const devAddr = parseInt(addrSelect.value, 16);
        const regByte = parseInt(addr, 16);
        await drv.regWrite(devAddr, regByte, bytes);
        log('TX', `Reg ${addr} ← ${input.value}`);
      } catch (err) { handleError(err, `Reg schreiben ${addr}`); }
    }
  });

  // ── Connection state ───────────────────────────────────────────────────────
  drv.addEventListener('connected', () => {
    if (devSelect.value) {
      btnReadAll.disabled = false;
      updatePollStartBtn();
      scriptsList.querySelectorAll('.btn-script').forEach(b => { b.disabled = false; });
    }
  });
  drv.addEventListener('disconnected', () => {
    btnReadAll.disabled = true;
    stopPolling();
    updatePollStartBtn();
    scriptsList.querySelectorAll('.btn-script').forEach(b => { b.disabled = true; });
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

// Expose copyResult globally so inline onclick handlers in index.html can reach it
window.copyResult = copyResult;

function init() {
  // Mount xterm.js terminal into the log container
  term.open($('log'));
  fitAddon.fit();
  // Re-fit on window resize
  window.addEventListener('resize', () => fitAddon.fit());

  // Check Web Serial support
  if (!I2CDriver.isSupported()) {
    $('browser-warning').style.display = 'block';
    $('btn-connect').disabled = true;
  }

  // Populate pullup selects
  ['pullup-sda', 'pullup-scl'].forEach(id => {
    const sel = $(id);
    PULLUP_OPTIONS.forEach(opt => {
      const o = document.createElement('option');
      o.value = String(opt.bits);
      o.textContent = opt.label;
      sel.appendChild(o);
    });
  });

  // Build scan table
  buildScanTable();

  // Device Explorer
  initDeviceExplorer();

  // Initial UI state
  setConnected(false);

  // Log welcome
  log('INFO', 'I²CDriver Web Control bereit. Gerät verbinden und auf „Verbinden" klicken.');
  if (!I2CDriver.isSupported()) {
    log('ERROR', 'Web Serial API nicht verfügbar – bitte Chrome oder Edge (≥89) verwenden.');
  }
}

init();
