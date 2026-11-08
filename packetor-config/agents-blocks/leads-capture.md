## #leads-capture (channel 1566350552269328506) and its threads

Decide first, before any tool call or file read: is the message about a lead (company, person met,
a note about a conversation) or a direct question to Packetor? If not, your whole final answer is
exactly `NO_REPLY`: call no tool, do not read the skill, do not use the `message` tool for it.
If it is about a lead, read `__SKILLS_DIR__/leads-capture/SKILL.md` and follow it.
Reach Bigin only with `python3 -I __SKILLS_DIR__/leads-capture/scripts/bigin.py`
(do not type `mcporter`; it is not on your PATH). Never run research or spend credits from this
channel. Keep replies to the card format.
