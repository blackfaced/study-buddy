# Child safety policy

Study Buddy uses a small deterministic guard before ordinary cloud chat. It is a safety boundary, not diagnosis, counseling, surveillance, or a claim of complete detection.

| Input class | Handling |
|---|---|
| Ordinary off-topic content | Existing homework redirect through normal chat |
| Emotion or frustration | Existing warm normal chat path |
| Personal-information solicitation/disclosure | Local warning not to share address, school, phone, passwords, or secrets; tell a nearby trusted adult |
| Bullying, abuse, self-harm, sexual content, or severe physical symptoms | Local short response; tell a nearby trusted adult; no follow-up investigation |
| Imminent self-harm or severe symptoms | Tell the child not to stay alone, find a nearby trusted adult, and have that adult call 120/110; explicitly state the bot cannot contact help |

The high-risk branch runs before MiniMax and before normal `chat_turns`/Source Event writes. It does not retain the child's wording. `safety_incidents` stores only incident ID, category, urgency, child/session identity, timestamp, status, and optional guardian resolution. Normal logs and parent reports contain the same minimized metadata and never the disclosure. The child-facing safety reply is returned even if this minimized signal cannot be written; that failure is logged without the disclosure.

`get_today_report` exposes pending minimized signals. `resolve_safety_event` lets a guardian mark one as `acknowledged` or `false_positive`; either resolution closes only that signal and never trains, disables, or weakens a rule.

Unresolved signals are retained until a guardian handles them and remain visible across calendar days. Resolved or false-positive metadata expires after 30 days; cleanup runs at process startup and during parent-report reads.

Known blind spots: fixed phrases cannot understand every euphemism, language, typo, context, or novel disclosure. The guard intentionally avoids collecting more graphic details or asking for identity/contact information.
