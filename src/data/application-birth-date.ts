// Keep existing birth-date drafts and consumers compatible with the shared model.
export {
  dateParts as birthDateParts,
  canonicalDate as canonicalBirthDate,
  dateDraftValue as birthDateDraftValue,
  type DateParts as BirthDateParts,
} from "./date-input";
