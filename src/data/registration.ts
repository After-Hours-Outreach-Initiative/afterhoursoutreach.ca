export interface RegistrationAnswers {
  name: string;
  pronouns: string;
  phone: string;
  birthDate: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelationship: string;
  heardAboutUs: string;
  motivation: string;
  teams: string[];
  certification: string;
  experience: string;
  medicalConditions: string;
}

export const registrationFields = [
  {
    name: "name",
    section: "personal-info",
    label: "Full or preferred name",
    required: true,
    autocomplete: "name",
  },
  {
    name: "pronouns",
    section: "personal-info",
    label: "Pronouns",
    required: false,
  },
  {
    name: "phone",
    section: "personal-info",
    label: "Phone number",
    required: true,
    type: "tel",
    autocomplete: "tel",
  },
  {
    name: "birthDate",
    section: "personal-info",
    label: "Date of birth",
    required: true,
    type: "date",
    help: "Used to understand volunteer age and eligibility.",
  },
  {
    name: "emergencyName",
    section: "emergency-contact",
    label: "Emergency contact name",
    required: true,
    help: "Someone we can contact if you need help during an event.",
  },
  {
    name: "emergencyPhone",
    section: "emergency-contact",
    label: "Emergency contact phone",
    required: true,
    type: "tel",
  },
  {
    name: "emergencyRelationship",
    section: "emergency-contact",
    label: "Relationship to emergency contact",
    required: true,
  },
  {
    name: "heardAboutUs",
    section: "about-volunteering",
    label: "How did you hear about us?",
    required: true,
    registrationOnly: true,
  },
  {
    name: "motivation",
    section: "about-volunteering",
    label: "Why do you want to volunteer?",
    required: true,
    multiline: true,
    registrationOnly: true,
  },
  {
    name: "certification",
    section: "training-and-safety",
    label: "Highest medical certification",
    required: true,
    help: "Write “None” if you do not have a medical certification.",
  },
  {
    name: "experience",
    section: "training-and-safety",
    label: "Other training and experience",
    required: true,
    multiline: true,
    help: "Write “None” if this is your first experience.",
  },
  {
    name: "medicalConditions",
    section: "training-and-safety",
    label: "Medical conditions or triggers",
    required: false,
    multiline: true,
    help: "Optional. Used to help organizers support your safety during events.",
  },
] as const;

export const profileFields = registrationFields.filter(
  (field) => !("registrationOnly" in field),
);
