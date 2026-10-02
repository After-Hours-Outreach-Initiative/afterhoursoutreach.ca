-- Each write is checked inside SQLite, so concurrent requests cannot overbook.
CREATE TRIGGER signup_confirm_insert
BEFORE INSERT ON signup WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'signup_not_eligible')
  WHERE NOT EXISTS (
    SELECT 1 FROM event e
    JOIN volunteer_status v ON v.user_id = NEW.user_id
    JOIN profile p ON p.user_id = v.user_id
    WHERE e.id = NEW.event_id AND e.open = 1 AND v.active = 1
      AND e.starts_at > (julianday('now') - 2440587.5) * 86400000
      AND (e.type = 'orientation' OR v.patrol_approved = 1)
  );
  SELECT RAISE(ABORT, 'event_full')
  WHERE (SELECT count(*) FROM signup WHERE event_id = NEW.event_id AND status = 'confirmed')
    >= (SELECT spots FROM event WHERE id = NEW.event_id);
END;
--> statement-breakpoint
CREATE TRIGGER signup_confirm_update
BEFORE UPDATE OF status, event_id, user_id ON signup WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'signup_not_eligible')
  WHERE NOT EXISTS (
    SELECT 1 FROM event e
    JOIN volunteer_status v ON v.user_id = NEW.user_id
    JOIN profile p ON p.user_id = v.user_id
    WHERE e.id = NEW.event_id AND e.open = 1 AND v.active = 1
      AND e.starts_at > (julianday('now') - 2440587.5) * 86400000
      AND (e.type = 'orientation' OR v.patrol_approved = 1)
  );
  SELECT RAISE(ABORT, 'event_full')
  WHERE (SELECT count(*) FROM signup WHERE event_id = NEW.event_id AND status = 'confirmed' AND id != OLD.id)
    >= (SELECT spots FROM event WHERE id = NEW.event_id);
END;
--> statement-breakpoint
CREATE TRIGGER event_capacity_update
BEFORE UPDATE OF spots ON event
BEGIN
  SELECT RAISE(ABORT, 'capacity_below_signups')
  WHERE NEW.spots < (SELECT count(*) FROM signup WHERE event_id = OLD.id AND status = 'confirmed');
END;
--> statement-breakpoint
CREATE TRIGGER orientation_completion_insert
BEFORE INSERT ON orientation_completion
BEGIN
  SELECT RAISE(ABORT, 'not_an_orientation')
  WHERE NOT EXISTS (SELECT 1 FROM event WHERE id = NEW.event_id AND type = 'orientation');
END;
--> statement-breakpoint
CREATE TRIGGER orientation_completion_update
BEFORE UPDATE OF event_id ON orientation_completion
BEGIN
  SELECT RAISE(ABORT, 'not_an_orientation')
  WHERE NOT EXISTS (SELECT 1 FROM event WHERE id = NEW.event_id AND type = 'orientation');
END;
--> statement-breakpoint
CREATE TRIGGER approval_organizer_insert
BEFORE INSERT ON volunteer_status WHEN NEW.patrol_approved = 1
BEGIN
  SELECT RAISE(ABORT, 'approval_requires_organizer')
  WHERE NOT EXISTS (SELECT 1 FROM user WHERE id = NEW.approved_by AND role = 'organizer');
END;
--> statement-breakpoint
CREATE TRIGGER approval_organizer_update
BEFORE UPDATE OF patrol_approved, approved_by ON volunteer_status WHEN NEW.patrol_approved = 1
BEGIN
  SELECT RAISE(ABORT, 'approval_requires_organizer')
  WHERE NOT EXISTS (SELECT 1 FROM user WHERE id = NEW.approved_by AND role = 'organizer');
END;
