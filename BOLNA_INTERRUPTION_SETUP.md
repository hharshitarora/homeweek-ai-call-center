# Bolna: Agent Speaking Before the User Finishes (Cutting Off Mid-Sentence)

If the agent starts speaking before the user has finished their sentence, the **cause** is usually **endpointing** (and related settings) being too low. The system treats a short pause as "user is done" and sends the partial transcript to the LLM, so the agent responds too soon.

---

## What was fixed in code (prompt)

1. **`src/server.js` — `buildPromptFromRow()`**  
   Added a **Never interrupt the lead** section: wait for the full sentence or thought; if unsure they're done, wait; never talk over the lead.

2. **`bolna-agent-prompt.txt`**  
   Added **NEVER INTERRUPT THE LEAD** and tightened **INTERRUPTION HANDLING** so the agent is instructed to wait for the lead to finish before responding.

Prompt rules alone cannot fix this if the **platform** sends partial speech to the LLM after a brief silence. You must also increase endpointing (and optionally linear delay) in Bolna.

---

## What to configure in Bolna Dashboard (root cause)

From [Bolna Transcriber Tab](https://docs.bolna.ai/playground/transcriber-tab):

- **Endpointing** – *"Number of milliseconds your agent will wait before generating response. Lower endpointing reduces latency **could lead to agent interrupting mid-sentence**. If you are expecting users to speak longer sentences, **keep a higher (500ms) endpoint**."*

Your execution showed `endpointing: 700`. For users who pause mid-sentence or speak in longer chunks, **increase endpointing** so the system waits longer before considering the user "done":

1. In Bolna: open your agent → **Transcriber** tab (or **Transcriber Tab** in Playground).
2. Find **Endpointing** (milliseconds).
3. **Increase it** — e.g. **800–1200 ms** (or 1000 ms as a starting point). If users still get cut off, try 1200–1500 ms.
4. Save the agent.

- **Linear delay** (if available) – *"Accounts for long pauses mid-sentence. If the recipient is expected to speak long sentences, increase value of linear delay."*  
  Increase this if users often pause for a second or two in the middle of a sentence.

- **Interruption settings** – *"Agent will not consider interruption until human speaks these number of words."*  
  Prevents the agent from treating short listener cues ("Oh", "yes", "hmm") as a full turn. Keep or slightly increase so the agent doesn’t jump in on backchannels.

---

## Summary

| What | Where | Action |
|------|--------|--------|
| **Endpointing** | Bolna → Agent → **Transcriber** tab | Set to **800–1200 ms** (or higher) so the agent doesn’t respond after every short pause. |
| **Linear delay** | Same (Transcriber / task config) | Increase if users often pause mid-sentence. |
| **Prompt** | `server.js` + `bolna-agent-prompt.txt` | Already updated: wait for full sentence; never interrupt. |

Ref: [Transcriber Tab – Configuration options](https://docs.bolna.ai/playground/transcriber-tab#configuration-options)
