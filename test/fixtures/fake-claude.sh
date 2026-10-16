#!/bin/sh
# Stands in for `claude -p` in tests: emits stream-json like the real CLI.
echo '{"type":"system","subtype":"init"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Writing the spec."},{"type":"tool_use","name":"Write","input":{"file_path":"docs/specs/x/SPEC.md"}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"[factory guard] blocked"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"total_cost_usd":0.42,"result":"Done.","terminal_reason":"completed"}'
