# Volunteer registration

How volunteers register. The registration form is part of each account.

## Flow

1. `/volunteer` has a button to create an account.
2. The person signs in. See [accounts.md](accounts.md).
3. A new account goes to the registration form. The privacy notice is shown at
   the top.
4. Once they submit, the account is pending until an organizer approves it.
5. Organizers get an email about each new registration.
6. The volunteer gets an email when they are approved.

## Profile

Everything from the form is saved as the person's profile. They can see and
edit it at `/account`, and delete their account from there.

## Fields

Taken from the current Google Form. The volunteer and organizers can see all of
them.

| Field                                    | Required |
| ---------------------------------------- | -------- |
| Full or preferred name                   | Yes      |
| Email (from the account)                 | Yes      |
| Pronouns                                 | No       |
| Phone number                             | Yes      |
| Date of birth                            | Yes      |
| Emergency contact name                   | Yes      |
| Emergency contact phone                  | Yes      |
| Emergency contact relationship           | Yes      |
| How did you hear about us                | Yes      |
| Why do you want to volunteer             | Yes      |
| Teams (outreach, medic, non-patrol)      | Yes      |
| Highest medical certification            | Yes      |
| Other training and experience, and other | Yes      |
| Medical conditions or triggers           | No       |

The name shown on patrol rosters is the name from this form.

Date of birth, emergency contact, and medical conditions each have a short line
under them saying what the information is used for.

## Discord

The page shown after submitting the form links to the Discord.

## TODO

- TODO: decide if we need the full date of birth, or only a checkbox confirming
  the person is 19 or older.
- TODO: decide if the medical certification should be checked, for example by
  asking for a licence number or a photo of the certificate. If so, uploads
  need R2 storage and more privacy work.
- TODO: fix the typos in the current form options when copying them over
  ("Nalaxone", "wiith", "Pa:ramedic", "relatons", "opiod", "ventiliation").
- TODO: decide if phone number and emergency contact should be hidden from
  organizers except on the roster of a patrol the volunteer is signed up for.
- TODO: decide if volunteers need to accept a code of conduct or waiver as
  part of registering.
- TODO: decide which fields a volunteer can edit after they are approved, and
  if edits should be flagged to organizers.
- TODO: decide if orientation signup belongs in this flow. See the future
  changes in [patrol-scheduling.md](patrol-scheduling.md).
