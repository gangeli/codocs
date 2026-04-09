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
