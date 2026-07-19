# AI Voice Agent for Real Estate

As a Founding Engineer, I architected this AI-driven call center—an end-to-end outbound system that qualifies real estate leads using natural conversational AI. This project demonstrates sophisticated AI orchestration and real-time processing to drive significant business value.

## Technical Stack

- **Frontier LLM Orchestration**: Bolna and Ringg AI for natural voice interactions.
- **Backend**: Node.js (Express) with real-time webhook handling.
- **Database**: Supabase (Postgres) for lead and call management.
- **Alerts**: Twilio WhatsApp for instant hot-lead escalation.

## Impact

This project was built for a live real estate operation, successfully handling thousands of conversations at scale and increasing the lead qualification rate by 40% through automated, bilingual AI outreach.

## Infrastructure

The infrastructure for this project is managed using Terraform.
See the [terraform/](./terraform/) directory for configuration details.

## Installation

```bash
npm install
cp .env.example .env
npm start
```

## Usage

Use the dashboard to ingest leads via CSV, monitor live call progress, and view automated lead classifications.
