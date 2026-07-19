resource "supabase_project" "homeweek_ai" {
  organization_id = var.supabase_org_id
  name            = "homeweek-ai-call-center"
  region          = "us-east-1"
  db_password     = var.db_password
}
