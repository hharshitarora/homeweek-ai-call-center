# Bolna: Stop Pushy Behavior When Lead Says "Not Interested"

This doc summarizes what was fixed in **code** and what you should configure in the **Bolna Dashboard** so the agent stops pitching when the user says they're not interested.

---

## What was fixed in code (root cause)

1. **`src/server.js` — `buildPromptFromRow()`**  
   The task sent to Bolna on each call now includes a **DISINTEREST & ENDING** section that explicitly instructs the agent to:
   - Treat "not interested", "not looking", "don't want", "stop" (in any language) as a signal to end.
   - Say **one** short polite goodbye and **not** pitch again or ask "Would you like to hear about...?".

2. **`bolna-agent-prompt.txt`**  
   The reference prompt used in Bolna Playground was updated with the same rules so the agent’s base behavior (Overview/default prompt) matches.

---

## What to configure in Bolna Dashboard

These settings make the **call actually end** and add a safety net so the agent doesn’t keep talking after disinterest.

### 1. Hangup prompt (intelligent disconnect)

Bolna can use a **prompt** to decide when the conversation is complete and disconnect the call.

- In Bolna: your agent → **Hangup / Disconnect** (or equivalent) settings.
- Find the **custom hangup prompt** (the one that “determines whether to disconnect the call”).
- Ensure it includes **disinterest** as a reason to consider the conversation complete.

**Suggested hangup prompt (add to or merge with what you have):**

```text
You are an AI assistant determining if a conversation is complete. The conversation is complete if:

1. The user explicitly says they want to stop (e.g. "That's all", "I'm done", "Goodbye", "thank you", "no thanks").
2. The user clearly states they are NOT interested, NOT looking, don't want to continue, or asks to stop (in any language or phrasing, e.g. "not interested", "I'm not looking", "don't want", "nahi", "no").
3. The user seems satisfied and their goal appears to be achieved.
4. The user's goal appears achieved based on the conversation history, even without explicit confirmation.

If none of these apply, the conversation is not complete.
```

- Tune this prompt for your use case; the important part is **(2)** so that “not interested” triggers a disconnect after the agent says goodbye.

Ref: [Hangup and Disconnect Bolna Voice AI calls](https://docs.bolna.ai/hangup-calls)

---

### 2. Guardrails (safety net for “not interested”)

Guardrails let you define **unwanted utterances** and what the agent should **say or do** when they’re detected (e.g. a single polite goodbye instead of continuing to pitch).

- In Bolna: your agent → **Guardrails** (or **Implementing Guardrails** in the docs).
- Add a guardrail that:
  - **Name:** e.g. `Disinterest – polite exit`
  - **Utterances (examples):**  
    `not interested`, `not looking`, `I'm not looking`, `don't want`, `no thanks`, `stop`, `nahi`, `no`, `I don't want to`, `not right now`, `busy`, `call later`
  - **Response:** The exact line the agent should say when this is detected, e.g.  
    `No problem. Thank you for your time. Goodbye.`
  - **Threshold:** Set so that clear disinterest phrases trigger the response without being too sensitive (adjust based on testing).

This way, even if the main prompt is ignored once, the guardrail can force a single closing line and avoid further pitching.

Ref: [Implementing Guardrails for Bolna Voice AI Agents](https://www.bolna.ai/docs/guardrails)

---

### 3. Optional: Hangup message

If Bolna allows a **hangup message** (final message before the call ends), set it to a short, polite line so the last thing the lead hears is consistent, e.g.:

- `Thank you for your time. Goodbye.`

Ref: [Hangup and Disconnect – personalized hangup message](https://docs.bolna.ai/hangup-calls#how-to-add-a-personalized-hangup-message)

---

## Summary

| Layer | Purpose |
|-------|--------|
| **Prompt (server + Playground)** | Agent **stops pitching** and says one goodbye when lead says not interested. |
| **Hangup prompt** | Bolna **disconnects the call** when it detects the conversation is complete (including disinterest). |
| **Guardrails** | **Fallback**: if the model still tries to pitch, guardrail triggers a single goodbye response. |

Together, these fix the issue at the **cause** (prompt) and add **Bolna-level** behavior (hangup + guardrails) so the agent is not pushy when the user says they’re not interested.
