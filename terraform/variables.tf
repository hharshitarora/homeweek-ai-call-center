variable "supabase_org_id" {
  description = "Supabase Organization ID"
  type        = string
}

variable "db_password" {
  description = "Supabase Database Password"
  type        = string
  sensitive   = true
}
