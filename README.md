# System Monitor (Cinnamon applet)

Three small panel charts: CPU, RAM, and network (upload grows up from the
middle, download grows down). Hover for the numbers. Right-click → Configure
to change each color or turn charts on and off.

## Install

```sh
make install
```

Then right-click the panel → Applets → add **System Monitor**.

After editing the code, `make reload` reloads the applet and `make test` runs
the parser checks.
