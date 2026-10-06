DROP TABLE `email_challenge`;--> statement-breakpoint
DROP TRIGGER bootstrap_first_organizer;--> statement-breakpoint
CREATE TRIGGER bootstrap_first_organizer BEFORE INSERT ON organizer_bootstrap
BEGIN
  SELECT RAISE(ABORT, 'organizer_already_exists') WHERE EXISTS (SELECT 1 FROM user WHERE role='organizer');
  SELECT RAISE(ABORT, 'organizer_not_ready') WHERE NOT EXISTS (
    SELECT 1 FROM user u JOIN profile p ON p.user_id=u.id JOIN volunteer_status v ON v.user_id=u.id
    WHERE u.id=NEW.user_id AND u.email_verified=1 AND v.active=1
  );
END;
