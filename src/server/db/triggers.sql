-- Current database-enforced business rules. Edit this source, then run pnpm db:generate.
-- Each trigger is one statement; the generator preserves it in a frozen migration.

-- Check eligibility and capacity inside SQLite so concurrent writes cannot overbook.
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

-- Completion is recorded separately from patrol approval.
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
--> statement-breakpoint

-- Existing spots survive hiding/closing; new confirmed spots must be visible.
CREATE TRIGGER signup_visible_insert BEFORE INSERT ON signup WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'signup_not_eligible') WHERE EXISTS (
    SELECT 1 FROM event WHERE id = NEW.event_id AND (hidden = 1 OR cancelled_at IS NOT NULL)
  );
END;
--> statement-breakpoint
CREATE TRIGGER signup_visible_update BEFORE UPDATE OF status, event_id, user_id ON signup WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'signup_not_eligible') WHERE EXISTS (
    SELECT 1 FROM event WHERE id = NEW.event_id AND (hidden = 1 OR cancelled_at IS NOT NULL)
  );
END;
--> statement-breakpoint

-- Preserve at least one active organizer.
CREATE TRIGGER keep_last_organizer BEFORE UPDATE OF role ON user
WHEN OLD.role = 'organizer' AND NEW.role != 'organizer'
BEGIN
  SELECT RAISE(ABORT, 'last_organizer') WHERE (SELECT count(*) FROM user WHERE role = 'organizer') <= 1;
  SELECT RAISE(ABORT, 'last_organizer') WHERE NOT EXISTS (
    SELECT 1 FROM user u JOIN volunteer_status v ON v.user_id=u.id
    WHERE u.id != OLD.id AND u.role='organizer' AND v.active=1
  );
END;
--> statement-breakpoint
CREATE TRIGGER keep_last_active_organizer BEFORE UPDATE OF active ON volunteer_status
WHEN OLD.active = 1 AND NEW.active = 0 AND EXISTS (SELECT 1 FROM user WHERE id = OLD.user_id AND role = 'organizer')
BEGIN
  SELECT RAISE(ABORT, 'last_organizer') WHERE (
    SELECT count(*) FROM user u JOIN volunteer_status v ON v.user_id = u.id WHERE u.role = 'organizer' AND v.active = 1
  ) <= 1;
END;
--> statement-breakpoint

-- One-time organizer bootstrap: verified email and active registration, no mandatory 2FA.
CREATE TRIGGER bootstrap_first_organizer BEFORE INSERT ON organizer_bootstrap
BEGIN
  SELECT RAISE(ABORT, 'organizer_already_exists') WHERE EXISTS (SELECT 1 FROM user WHERE role='organizer');
  SELECT RAISE(ABORT, 'organizer_not_ready') WHERE NOT EXISTS (
    SELECT 1 FROM user u JOIN profile p ON p.user_id=u.id JOIN volunteer_status v ON v.user_id=u.id
    WHERE u.id=NEW.user_id AND u.email_verified=1 AND v.active=1
  );
END;
--> statement-breakpoint
CREATE TRIGGER bootstrap_first_organizer_apply AFTER INSERT ON organizer_bootstrap
BEGIN
  UPDATE user SET role='organizer',updated_at=NEW.created_at WHERE id=NEW.user_id;
  INSERT INTO audit_log(id,actor_id,subject_id,action,changed_fields,created_at)
    VALUES(lower(hex(randomblob(16))),NEW.user_id,NEW.user_id,'role_changed','["role"]',NEW.created_at);
  DELETE FROM session WHERE user_id=NEW.user_id;
END;
