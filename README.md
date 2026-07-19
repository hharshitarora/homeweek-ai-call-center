# 📞 HomeWeek AI Call Center
### Scaling human-level qualification to thousands of leads.

This isn't just a dialer; it's an end-to-end outbound AI ecosystem that qualifies real estate leads with natural, bilingual conversational intelligence. Built with the rigors of a Founding Engineer, it handles the "grunt work" of lead outreach so your team can focus on closing.

## 🚀 The Product Experience
HomeWeek AI transforms cold leads into qualified opportunities. By combining low-latency voice synthesis with sophisticated classification logic, it increased lead qualification rates by **40%** for a live real estate operation.

### 🔄 Process Flow
```text
[ CSV Lead Ingest ] --> [ Bolna/Ringg AI Engine ] --> [ Live Voice Call ]
                                                            |
                                                            v
[ Instant Escalation ] <--(Hot Lead)--- [ Real-time Lead Classification ]
(Twilio WhatsApp)                            (Supabase / Postgres)
```

## 🛠️ Technical Stack
- **Voice Orchestration**: **Bolna** and **Ringg AI** for ultra-natural, low-latency interactions.
- **Core Engine**: **Node.js (Express)** handling high-concurrency webhooks.
- **Persistence Layer**: **Supabase (Postgres)** for lead state and call lifecycle management.
- **Hot-Lead Escalation**: **Twilio WhatsApp** API for instant agent notifications.

## 📈 Engineering Impact
- Handled **thousands of concurrent conversations** in a live production environment.
- **40% increase** in qualified leads through automated, high-frequency outreach.
- Successfully deployed as a mission-critical tool for a real estate business.

---

## 🏗️ Infrastructure
Managed via Infrastructure as Code (Terraform).
See the [terraform/](./terraform/) directory for configuration.

## 📥 Installation
```bash
npm install
cp .env.example .env
npm start
```

## 🎮 Usage
1. Ingest leads via CSV on the management dashboard.
2. Monitor live call progress and sentiment in real-time.
3. Receive instant WhatsApp alerts for "Hot Leads" ready for human takeover.
