PROJECT=signal_visualizer

# Resolve the frontend directory relative to this Makefile, regardless of
# where make is invoked from (brand/ invokes make -C here, so $(CURDIR) varies).
THIS_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
FRONTEND_DIR := $(THIS_DIR)../../frontend

# Sentinel: static/index.html is produced by the frontend build.
# Make only re-runs the frontend target when TS/TSX/CSS sources or
# package.json are newer than this file.
STATIC_INDEX := $(THIS_DIR)static/index.html

# Collect frontend source files as dependencies so Make can detect changes.
# $(wildcard) doesn't support **, so use $(shell find ...) for subdirectories.
FRONTEND_SRCS := $(shell find $(FRONTEND_DIR)/src -name "*.ts" -o -name "*.tsx" 2>/dev/null) \
                 $(wildcard $(FRONTEND_DIR)/package.json) \
                 $(wildcard $(FRONTEND_DIR)/vite.config.ts) \
                 $(wildcard $(FRONTEND_DIR)/index.html)

all: $(PROJECT).bin $(STATIC_INDEX)

$(PROJECT).bin: $(PROJECT).py
	@echo "#!/bin/bash" > $(PROJECT).bin
	@echo 'SCRIPT_DIR="$$(cd "$$(dirname "$$0")" && pwd)"' >> $(PROJECT).bin
	@echo 'exec python "$$SCRIPT_DIR/$(PROJECT).py" "$$@"' >> $(PROJECT).bin
	chmod +x $(PROJECT).bin

# Build the React frontend. Only runs when source files are newer than
# static/index.html (or on a fresh clone where static/index.html doesn't exist).
# npm install is skipped if node_modules already exists (fast repeated builds).
$(STATIC_INDEX): $(FRONTEND_SRCS)
	@if command -v npm >/dev/null 2>&1; then \
		echo "[brand-monitor] Building frontend..."; \
		cd $(FRONTEND_DIR) && \
		([ -d node_modules ] || npm install) && \
		npm run build; \
		echo "[brand-monitor] Frontend build complete."; \
	else \
		echo ""; \
		echo "[brand-monitor] WARNING: npm not found — skipping frontend build."; \
		echo "  Install Node.js:"; \
		echo "    macOS:  brew install node"; \
		echo "    Ubuntu: sudo apt-get install -y nodejs npm"; \
		echo "  Then run: cd $(FRONTEND_DIR) && npm install && npm run build"; \
		echo ""; \
	fi

clean:
	$(RM) $(PROJECT).bin
	rm -rf $(THIS_DIR)static $(FRONTEND_DIR)/dist
