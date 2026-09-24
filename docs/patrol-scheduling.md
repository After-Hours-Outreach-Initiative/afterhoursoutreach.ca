# Patrol scheduling

Patrols show up at the bottom of the `/volunteer` page.

## Patrol list

A list of patrol cards, each consists of the date, the start time, the meeting
location, and how many spots are left. Patrols drop off the list once they have
passed.

## Sign in

See [accounts.md](accounts.md).

## Views per type of user

There are 3 types of users:

1. Visitor: not signed in
2. Volunteer: signed in with an email
3. Organizer: signed in with the organizer role

### 1. Visitors

The homepage shows sign in and lists upcoming patrols.

### 2. Volunteers

Each patrol has a sign up button, which adds a green "Signed up" badge and the
sign up button turns into a cancel button.

### 3. Organizers

Each patrol has extra an edit button and a roster details dropdown.

### Edit view

A popup that lets all fields be changed and the patrol be hidden/closed or
deleted.

### Roster view

The bottom of the patrol card has a roster details element that shows the list
of volunteers when expanded.

## Future changes

- maybe require volunteers to complete the sign up form and use a volunteer
  email allowlist from the sign up form emails. right now anyone with an email
  can sign up for patrols
- maybe make the organizer have a separate mode for organizer mode. by default
  they see the same patrol list as volunteers but to make admin changes they
  have to change the mode
- decide if we want volunteers to be removable, if so should be able to undo if
  accident
- when should patrols stop showing up onthe list, should it be after its over
  like 12am or a few hours before it starts like 6pm?
