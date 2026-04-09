variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "codocs-492718"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "pubsub_topic_name" {
  description = "Name of the Pub/Sub topic for comment events"
  type        = string
  default     = "codocs-comments"
}
