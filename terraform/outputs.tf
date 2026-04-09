output "pubsub_topic" {
  description = "Full Pub/Sub topic path (use this in codocs auth login)"
  value       = google_pubsub_topic.codocs_comments.id
}

output "pubsub_subscription" {
  description = "Full Pub/Sub subscription path"
  value       = google_pubsub_subscription.codocs_comments_pull.id
}

output "pubsub_topic_name" {
  description = "Topic name for codocs config"
  value       = var.pubsub_topic_name
}

output "codocs_bot_email" {
  description = "Email of the Codocs bot service account (share docs with this)"
  value       = google_service_account.codocs_bot.email
}

output "codocs_bot_key_path" {
  description = "Path where the service account key was written"
  value       = local_file.codocs_bot_key.filename
}
