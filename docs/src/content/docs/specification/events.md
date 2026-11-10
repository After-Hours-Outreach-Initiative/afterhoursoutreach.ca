---
title: Events
description: Patrol and orientation visibility, sign-ups, and organizer management.
---

Product rules for patrols, orientations, sign-ups, and organizer management. See
[Event implementation](/implementation/events/) for API and persistence details.

Patrols and orientations show up at the bottom of the `/volunteer` page. An
active account with an organizer-approved application is required to view events or
sign up for either. Organizers retain access through their role.

## Orientations

New volunteers usually sign up for an orientation first. After the orientation,
an organizer marks each person who attended as completed. Patrol signups require
explicit organizer approval. Completing orientation is the most common path to
approval, but is not required and does not automatically grant approval.

Progression and avatar colours follow manual approval everywhere: volunteers awaiting
patrol approval are blue, patrol-approved outreach volunteers are green, and
patrol-approved medic-team volunteers are red. Recorded orientation attendance never
changes a category, medic eligibility, or reserved-place counts. Volunteers awaiting
patrol approval may book multiple upcoming orientations, subject to each event's
capacity, reserved places, and recurring signup window.

Orientations use the same cards, edit view, and volunteer list as patrols.

## Event list

A list of event cards for patrols and orientations, each consists of the date,
the start time, the meeting location, and how many spots are left. Event signups
should be closed when the start time passes. Volunteers can still unregister
until each event's unregister time, set in minutes after the start (30 by
default).

Event cards update when events or application approval change. Updates preserve
filters, focus, and unsaved editor drafts.

## Views per type of user

There are 3 types of users:

1. Visitor: not signed in
2. Volunteer: signed in with an email
3. Organizer: signed in with the organizer role

### 1. Visitors

The homepage links to volunteer application/sign-in. Applications use `/apply`. Event details are not
available to visitors, including through direct requests. Background updates must not reveal event
activity to visitors or pending accounts.

### 2. Volunteers

Each event has a sign up button, which adds a green "Signed up"
badge and the sign up button turns into a cancel button.

Volunteers awaiting application approval cannot view events. After application
approval, volunteers who have not been approved for patrols can sign up for orientations.
Patrols are shown without a sign up button, with a note that organizer approval
is required.

### 3. Organizers

Each event has an extra edit button and a roster details dropdown.

**Select** shows a checkbox tab on top of each upcoming event card. While
selecting, a bar at the bottom of the screen shows the selection count with
**Select all**, **Clear**, and **Bulk edit**.

Bulk edit lists the selected events as compact cards above the event fields.
Fields shared by every selected event are prefilled; fields that differ are
blank and stay unchanged unless filled in. Only edited fields are saved. A new
start time applies to each event on its own date.

### Edit view

A popup for editing event details, public visibility, or cancelling the event.
The single **Public visibility** toggle shows the event to approved volunteers
and opens registration when on; when off, only organizers and existing
registrants can see it, and new registrations are blocked. Existing spots are
not cancelled. New events default to off. “Public” does not grant visitor or
pending-account access.

### Event volunteers list

The bottom of the event card has a roster details element that shows the list
of volunteers when expanded. Volunteers can be moved or removed in which case a
reason message can be added by the organizer who makes the change, and an email
can optionally be sent to the volunteer including the reason message. The
organizer is prompted to save with or without email; no email is sent or queued
unless they choose to send one. Event edits/cancellations and volunteer
access/role changes use the same optional email prompt.

On an orientation, the list also has a completed checkbox for each volunteer.
