-- รันใน SQL Server Management Studio (หรือ client ไปที่ฐาน MSSQL ระบบเก่า)
-- Export ผลลัพธ์เป็น CSV UTF-8
-- หัวคอลัมน์ต้องตรงลำดับกับตาราง migrate_stg.patient_info_mssql ใน Postgres (ดู 01_create_staging.sql)
--
-- ใน SSMS: Results -> Save Results As... หรือใช้ bcp / sqlcmd ตาม README

SELECT
  CAST([PID] AS NVARCHAR(MAX)) AS pid,
  CAST([Prefix] AS NVARCHAR(MAX)) AS prefix,
  CAST([Name] AS NVARCHAR(MAX)) AS [name],
  CAST([Surname] AS NVARCHAR(MAX)) AS surname,
  CONVERT(VARCHAR(30), [DateOfBirth], 126) AS date_of_birth_be,
  CAST([Single] AS NVARCHAR(MAX)) AS single,
  CAST([Address] AS NVARCHAR(MAX)) AS address,
  CAST([SubArea] AS NVARCHAR(MAX)) AS sub_area,
  CAST([Area] AS NVARCHAR(MAX)) AS area,
  CAST([Province] AS NVARCHAR(MAX)) AS province,
  CAST([Zip] AS NVARCHAR(MAX)) AS zip,
  CAST([Phone_BIZ] AS NVARCHAR(MAX)) AS phone_biz,
  CAST([Phone_Home] AS NVARCHAR(MAX)) AS phone_home,
  CAST(CAST([Height] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS height,
  CAST(CAST([Weight] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS weight,
  CAST([Current_Breast_Compo] AS NVARCHAR(MAX)) AS current_breast_compo,
  CAST([Current_implant_Type] AS NVARCHAR(MAX)) AS current_implant_type,
  CONVERT(VARCHAR(30), [LastExamDate], 126) AS last_exam_date,
  CAST([Mobile] AS NVARCHAR(MAX)) AS mobile,
  CONVERT(VARCHAR(30), [MobileUpdated], 126) AS mobile_updated,
  CAST(CAST([Donate_Type] AS NVARCHAR(50)) AS NVARCHAR(MAX)) AS donate_type,
  CAST([EngPrefix] AS NVARCHAR(MAX)) AS eng_prefix,
  CAST([EngName] AS NVARCHAR(MAX)) AS eng_name,
  CAST([EngSurname] AS NVARCHAR(MAX)) AS eng_surname,
  CAST([SocID] AS NVARCHAR(MAX)) AS soc_id,
  CAST([HN] AS NVARCHAR(MAX)) AS hn,
  CAST([Gender] AS NVARCHAR(MAX)) AS gender,
  CAST([Address2] AS NVARCHAR(MAX)) AS address2,
  CAST([ShortNote] AS NVARCHAR(MAX)) AS short_note,
  CAST([Disease] AS NVARCHAR(MAX)) AS disease,
  CAST([Mobile_Phone] AS NVARCHAR(MAX)) AS mobile_phone,
  CAST([Email] AS NVARCHAR(MAX)) AS email
FROM dbo.patient_info; -- ปรับ schema / ชื่อคอลัมน์ ให้ตรงกับระบบเก่าของคุณ
