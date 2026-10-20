-- Cap how many items a digest lists, so a backlog cannot produce an unreadable notification.
ALTER TABLE notification_rules ADD COLUMN max_items INTEGER NOT NULL DEFAULT 8;
