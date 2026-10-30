UUID := system-monitor@maryayi.github.io
APPLETS_DIR := $(HOME)/.local/share/cinnamon/applets

install:
	mkdir -p $(APPLETS_DIR)
	rm -rf $(APPLETS_DIR)/$(UUID)
	ln -s $(CURDIR)/applet $(APPLETS_DIR)/$(UUID)

reload:
	dbus-send --session --dest=org.Cinnamon.LookingGlass --type=method_call \
		/org/Cinnamon/LookingGlass org.Cinnamon.LookingGlass.ReloadExtension \
		string:$(UUID) string:APPLET

test:
	gjs -I applet test/stats-test.js

.PHONY: install reload test
