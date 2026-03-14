.PHONY: all node frontend clean

all: node frontend

node:
	$(MAKE) -C nodes/signal_visualizer

frontend:
	@if command -v npm >/dev/null 2>&1; then \
		cd frontend && npm install && npm run build; \
	else \
		echo "npm not found — skipping frontend build."; \
		echo "Install Node.js and run: cd frontend && npm install && npm run build"; \
	fi

clean:
	$(MAKE) -C nodes/signal_visualizer clean
	rm -rf frontend/node_modules frontend/dist nodes/signal_visualizer/static
