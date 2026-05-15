# ──────────────────────────────────────────────────────────────────────────────
# i2c-driver-webapp – Makefile
# ──────────────────────────────────────────────────────────────────────────────

PORT      ?= 5173          # dev-server port
GH_PORT   ?= 4173          # preview-server port (GitHub Pages path)
BASE_PATH ?= /i2c-driver-webapp/
SHOT_OUT  ?= app-screenshot.png

.PHONY: all install dev build build-gh preview preview-gh screenshot clean help

all: build                 ## Standard-Build (lokale Basis /)

# ── Abhängigkeiten ──────────────────────────────────────────────────────────

install:                   ## npm-Pakete installieren
	npm install

# ── Entwicklung ─────────────────────────────────────────────────────────────

dev:                       ## Vite Dev-Server starten (hot-reload, Basis /)
	npm run dev -- --port $(PORT)

# ── Build ───────────────────────────────────────────────────────────────────

build:                     ## Produktions-Build für lokalen Betrieb (Basis /)
	npm run build

build-gh:                  ## Produktions-Build für GitHub Pages (Basis $(BASE_PATH))
	BASE_PATH=$(BASE_PATH) npm run build

# ── Vorschau ────────────────────────────────────────────────────────────────

preview: build             ## Vorschau-Server für lokalen Build starten
	npx vite preview --port $(PORT)

preview-gh: build-gh       ## Vorschau-Server für GitHub-Pages-Build starten
	BASE_PATH=$(BASE_PATH) npx vite preview --port $(GH_PORT)

# ── Screenshot ──────────────────────────────────────────────────────────────

screenshot: build-gh       ## Build + Screenshot erstellen → $(SHOT_OUT)
	@echo "Starte Vorschau-Server auf Port $(GH_PORT)…"
	BASE_PATH=$(BASE_PATH) npx vite preview --port $(GH_PORT) & \
	PREVIEW_PID=$$!; \
	echo "Warte auf http://localhost:$(GH_PORT)$(BASE_PATH)"; \
	for i in $$(seq 1 30); do \
	  curl -sf http://localhost:$(GH_PORT)$(BASE_PATH) >/dev/null 2>&1 && break; \
	  echo "  … $$i/30"; sleep 1; \
	done; \
	node screenshot.mjs $(SHOT_OUT); \
	EXIT=$$?; \
	kill $$PREVIEW_PID 2>/dev/null || true; \
	exit $$EXIT

# ── Aufräumen ───────────────────────────────────────────────────────────────

clean:                     ## Build-Artefakte entfernen
	rm -rf dist/

# ── Hilfe ───────────────────────────────────────────────────────────────────

help:                      ## Diese Hilfe anzeigen
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*##"}{ printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }'
