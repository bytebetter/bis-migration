/**
 * สวิตช์ปิด/เปิด logic แยกแถว placeholder ใน migrate ของ patient_info และ appointment
 * (ปิดชั่วคราว — เปิดกลับเมื่อต้องการ insert-only ทับ placeholder / สร้าง patient_info ก่อนแมป appointment)
 */
export const PATIENT_INFO_MIGRATE_PLACEHOLDER_LOGIC_ENABLED = false;
export const APPOINTMENT_MIGRATE_PLACEHOLDER_LOGIC_ENABLED = false;
