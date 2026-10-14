import { z } from "zod";

// These mirror the database constraints (supabase/migrations/*_identity.sql) and the Supabase
// Auth password policy (supabase/config.toml), so users see problems before submitting.
export const ROLL_NUMBER_PATTERN = /^[A-Za-z0-9/-]{3,32}$/;
const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

export const passwordSchema = z
  .string()
  .min(8, "At least 8 characters")
  .regex(/[A-Za-z]/, "Include a letter")
  .regex(/[0-9]/, "Include a number");

export const loginSchema = z.object({
  email: z.email("Enter a valid email").trim(),
  password: z.string().min(1, "Enter your password"),
});

export const registerSchema = z
  .object({
    fullName: z.string().trim().min(1, "Enter your name").max(120),
    email: z.email("Enter a valid email").trim(),
    password: passwordSchema,
    customerType: z.enum(["student", "faculty"]),
    rollNumber: z
      .string()
      .trim()
      .regex(ROLL_NUMBER_PATTERN, "3–32 letters, numbers, / or -")
      .optional()
      .or(z.literal("")),
    department: optionalText(120),
    yearOfStudy: z
      .string()
      .regex(/^[1-8]?$/, "Year 1–8")
      .optional(),
  })
  .refine((v) => v.customerType === "faculty" || Boolean(v.rollNumber), {
    path: ["rollNumber"],
    message: "Students need their roll number",
  });

export type RegisterValues = z.infer<typeof registerSchema>;

/** Supabase signUp `options.data`; the database trigger turns it into the profile. */
export function registrationMetadata(values: RegisterValues): Record<string, string> {
  const data: Record<string, string> = {
    full_name: values.fullName.trim(),
    customer_type: values.customerType,
  };
  if (values.rollNumber) data.roll_number = values.rollNumber.trim();
  if (values.department) data.department = values.department.trim();
  if (values.yearOfStudy) data.year_of_study = values.yearOfStudy;
  return data;
}

export const profileSchema = z.object({
  fullName: z.string().trim().min(1, "Enter your name").max(120),
  department: optionalText(120),
  yearOfStudy: z
    .string()
    .regex(/^[1-8]?$/, "Year 1–8")
    .optional(),
  hostelRoom: optionalText(40),
});

export type ProfileValues = z.infer<typeof profileSchema>;

/** PATCH /me body: empty optional fields clear the value. */
export function profileUpdate(values: ProfileValues) {
  return {
    full_name: values.fullName.trim(),
    department: values.department ? values.department.trim() : null,
    year_of_study: values.yearOfStudy ? Number(values.yearOfStudy) : null,
    hostel_room: values.hostelRoom ? values.hostelRoom.trim() : null,
  };
}

export const forgotPasswordSchema = z.object({ email: z.email("Enter a valid email").trim() });
export const resetPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match" });
