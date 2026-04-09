terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ---------------------------------------------------------------------------
# Enable required APIs
# ---------------------------------------------------------------------------

resource "google_project_service" "pubsub" {
  service            = "pubsub.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "workspace_events" {
  service            = "workspaceevents.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "docs" {
  service            = "docs.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "drive" {
  service            = "drive.googleapis.com"
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Pub/Sub topic + pull subscription
# ---------------------------------------------------------------------------

resource "google_pubsub_topic" "codocs_comments" {
  name = var.pubsub_topic_name

  depends_on = [google_project_service.pubsub]
}

resource "google_pubsub_subscription" "codocs_comments_pull" {
  name  = "${var.pubsub_topic_name}-sub"
  topic = google_pubsub_topic.codocs_comments.id

  ack_deadline_seconds       = 20
  message_retention_duration = "604800s" # 7 days
  retain_acked_messages      = false

  expiration_policy {
    ttl = "" # never expires
  }

  depends_on = [google_pubsub_topic.codocs_comments]
}

# ---------------------------------------------------------------------------
# IAM: Allow Google Drive event push to publish to the topic
#
# Google Docs comment events are delivered through the Drive events pipeline.
# Google uses a fixed global service account for this, not a per-project agent.
# ---------------------------------------------------------------------------

resource "google_pubsub_topic_iam_member" "workspace_events_publisher" {
  topic  = google_pubsub_topic.codocs_comments.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:drive-api-event-push@system.gserviceaccount.com"
}
