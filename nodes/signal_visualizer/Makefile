PROJECT=signal_visualizer

all: $(PROJECT).bin

$(PROJECT).bin: $(PROJECT).py
	@echo "#!/bin/bash" > $(PROJECT).bin
	@echo 'SCRIPT_DIR="$$(cd "$$(dirname "$$0")" && pwd)"' >> $(PROJECT).bin
	@echo 'exec python "$$SCRIPT_DIR/$(PROJECT).py" "$$@"' >> $(PROJECT).bin
	chmod +x $(PROJECT).bin

clean:
	$(RM) $(PROJECT).bin
