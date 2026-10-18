#!/bin/sh
# Stands in for `claude -p` in tests: records argv to $FAKE_ARGV_FILE and emits
# a minimal successful stream-json result.
printf '%s\n' "$@" > "$FAKE_ARGV_FILE"
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.01,"result":"Done.","terminal_reason":"completed"}'
