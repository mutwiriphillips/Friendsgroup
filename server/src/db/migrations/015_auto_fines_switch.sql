-- Automatic fines (the late-payment fine and the unexcused-absence fine) can be suspended, e.g. while historical data is still being loaded.
-- Existing deployments start suspended. When switched back on, "from" is the first date the rules bite: only contributions due, and
-- meetings held, on or after it are fined automatically, so nothing from the suspended period is fined retroactively.
INSERT INTO system_settings (key, value) VALUES ('auto_fines', '{"enabled": false, "from": null}') ON CONFLICT (key) DO NOTHING;
