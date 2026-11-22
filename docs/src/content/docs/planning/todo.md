---
title: TODO
description: Stuff that is ready to work on.
---

- when event calendar is sticky on mobile it still has a top margin offset from
  when the header was sticky
- as soon as you change the month in the date picker for the event start date,
  it abruptly closes the picker and shows the past event start date warning
  message, that is not good ux, the message should not hijack focus from the
  date picker.
- past events should also remain editable, and the reservations/constraints
  should be removed so that any volunteers can be edited or added
- for volunteer manual add:
  - the last search result should be 'Manually add "<name-they-typed-in>"'. add
    option as a search result
  - manually added volunteer entries should be editable to change their name,
    or new/medic badges
- change the application process to not say submit until the very end, so step
  1 completing the form should say "continue", move the code of conduct to the
  last submission step, where the waiver will be aswell
- undo on mobile doesnt bring back the edit event dialog
- problems that happen on ios that i dont see on android:
  - TOC bar: the links dont do anything, no scrolling happens
  - when the calendar event link is clicked it breaks the app dock and it stops
    being sticky it gets placed wherever the bottom of the screen was when the
    event page was scrolled to the clicked event, then following scrolling
    shows that the app dock bar is stuck in the page, its no longer sticky
  - autocomplete results for the volunteer search in manually add volunteers
    and probably all the volunteer search results are not clickable
- if a volunteer is manually added, they should get an email notification about
  it
- change volunteer spots to show a visual with avatars of total spots and
  reservations and limits
- application steps should have a "1 of N" indicated somewhere
- fix rejected application scenarios: implement a way for applicants to change
  their application after being rejected and resubmit
- make the emails not be centered they should just flow normally and be left
  aligned
- add a team lead role
- add an email footer to the google workspace emails with logo, AHOI name, and
  website link
