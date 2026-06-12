/**
 * สวิตช์ปิด/เปิด placeholder ของ patient_info และ appointment
 * (ปิดชั่วคราว — เปิดกลับเมื่อต้องการสร้าง parent ก่อนแมปตารางลูก / insert-only ทับ placeholder)
 */
/** สร้างแถว patient_info "ไม่ทราบชื่อ" ผ่าน ensurePlaceholder* (ทุกตารางลูก + appointment) */
export const ENSURE_PLACEHOLDER_PATIENT_INFO_ENABLED = false;
/** สร้างแถว appointment "ไม่ทราบชื่อ" ผ่าน ensurePlaceholderAppointment (examination ฯลฯ) */
export const ENSURE_PLACEHOLDER_APPOINTMENT_ENABLED = false;
/** logic ใน migrate patient_info (จำแนก placeholder + insert-only ทับ placeholder) */
export const PATIENT_INFO_MIGRATE_PLACEHOLDER_LOGIC_ENABLED = false;
/** logic ใน migrate appointment (ensure patient + insert-only ทับ placeholder) */
export const APPOINTMENT_MIGRATE_PLACEHOLDER_LOGIC_ENABLED = false;
