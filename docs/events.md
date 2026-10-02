# Events

Patrols and orientations show up at the bottom of the `/volunteer` page. An
account is required to sign up for either.

## Orientations

New volunteers usually sign up for an orientation first. After the orientation,
an organizer marks each person who attended as completed. Patrol signups require
explicit organizer approval. Completing orientation is the most common path to
approval, but is not required and does not automatically grant approval.

Orientations use the same cards, edit view, and volunteer list as patrols.

## Event list

A list of event cards for patrols and orientations, each consists of the date,
the start time, the meeting location, and how many spots are left. Event signups
should be closed when the start time passes.

## Views per type of user

There are 3 types of users:

1. Visitor: not signed in
2. Volunteer: signed in with an email
3. Organizer: signed in with the organizer role

### 1. Visitors

The homepage shows sign in and lists upcoming events.

### 2. Volunteers

Each event has a sign up button, which adds a green "Signed up"
badge and the sign up button turns into a cancel button.

Volunteers who have not been approved for patrols can sign up for orientations.
Patrols are shown without a sign up button, with a note that organizer approval
is required.

### 3. Organizers

Each event has an extra edit button and a roster details dropdown.

### Edit view

A popup that lets all fields be changed and the event be hidden/closed or
deleted.

### Event volunteers list

The bottom of the event card has a roster details element that shows the list
of volunteers when expanded. Volunteers can be moved or removed in which case a
reason message can be added by the organizer who makes the change, and an email
will be sent to the volunteer including the reason message.

On an orientation, the list also has a completed checkbox for each volunteer.

## TODO

- TODO: decide if cancelled signups are kept, or deleted.
- TODO: decide how long past events and their rosters are kept.
- TODO: decide if volunteers who have completed an orientation still see
  upcoming orientations
- TODO: should events in the past show up at all, maybe they stay visible for
  a week or so, or maybe we have a full history visible to any visitor?
