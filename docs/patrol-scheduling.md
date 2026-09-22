# Patrol scheduling

How patrol scheduling and volunteer signup work on afterhoursoutreach.ca.

## Patrol list

A list of patrol cards, each consists of the date, the start time, the meeting
location, and how many spots are left. Patrols drop off the list once they have
passed.

## Sign in process

The authentication method will be an email magic link.

1. The person enters their email address and asks for a link.
2. The email holds two ways in: a sign in link, and a 6 digit code.
3. Opening the link signs in whichever device opens it. Typing the code signs
   in the device that asked for it.
4. The first time an email address is used it asks for a name. That name is
   what organizers see on the roster.

The email contains a sign in link or a 6 digit code to support opening the
email on another device than the one trying to sign in to the website. Either
signs the person in, using one spends the other, and both stop working after 1
hour. 10 wrong codes cancel the request and a new one has to be asked for.

The session stays on the device until the person signs out. Being on the
organizer allowlist is what makes someone an organizer, so there is no separate
organizer login.

## Views per type of user

There are 3 types of users:

1. Visitor: not signed in
2. Volunteer: signed in with an email
3. Organizer: signed in with an email and on the organizer allowlist

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

## Other

The sign in form is protected against bots and rate limited, so no one can fill
a patrol with fake names or mailbomb someone. The limit counts both the email
address being sent to and the address asking, since either one on its own is
easy to work around.

Clicking the sign in link signs the person in and redirects to the /patrols
page. Fetching the link is not what spends the token. The link opens a page,
and that page makes the request that completes the sign in. Mail scanners and
link previewers fetch every URL in a message without running the page, so the
link still works when the person gets to it.

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
