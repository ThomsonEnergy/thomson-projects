-- Migration 066 — Seed the onboarding documents
-- Run this in Supabase: SQL Editor > New query > paste > Run.
-- Run AFTER migration_065_employee_onboarding.sql.
--
-- Seeds onboarding_documents with the real policy text and the raw
-- employment contract template, committed to the repo at
-- "policies and Contracts/" (commit 8fdc51c). All four are editable
-- afterwards from Settings > Onboarding Documents - this just saves
-- re-typing them in by hand. Only runs if the table is still empty, so
-- it won't clobber edits made after the first run.

insert into onboarding_documents (title, body, is_required, is_contract, sort_order)
select * from (values
('Employment Contract', $doc$[insert Thomson Energy Australia Pty Ltd ACN 689 985 831 letterhead]

[insert date]

[insert employee name]
[insert employee address]

Dear [insert employee name]
Thomson Energy Australia Pty Ltd ACN 689 985 831 (Employer)
Offer of employment with the Employer

We are pleased to offer you employment, on a [full-time / part-time / casual] basis, as [insert position].

Please read through the terms and conditions of this employment agreement (Terms) carefully.

Should you wish to accept this offer of employment, please sign and date your acceptance, where indicated, and return a signed copy to us.

1. Position
1.1 Role and duties
You will be employed as [insert position]. Your duties will include the duties set out in your job description, as in place from time to time, and any other duties allocated to you by the Employer, from time to time (Duties).
1.2 Location
Your location of work is [insert location of work], or any other location as the Employer may require from time to time on a temporary or permanent basis.

2. Period of Employment [Delete the options which are not applicable]
[for existing permanent part-time and full-time employees]
2.1 As an existing employee, your commencement date of employment with the Employer will of course continue to be the first time you worked for us, being [insert date] (including for all service-related entitlements) (Commencement Date).
2.2 This employment agreement will not have the effect of altering the Commencement Date.
[for all new employees]
2.1 Commencement Date
The commencement date for your employment is [insert date] (Commencement Date).
2.2 Probation
2.2.1 Your employment is subject to a probationary period of six (6) months commencing on the Commencement Date (Probationary Period).
2.2.2 During the Probationary Period, either you or the Employer may terminate your employment by giving one (1) week's notice in writing or in the case of the Employer paying one (1) week's wages in lieu of notice.
2.2.3 The Employer may extend the Probationary Period for a reasonable period (of which you will be advised in writing).
2.2.4 For the avoidance of doubt, no notice is required under clause 2.2(b) if the Employer terminates your employment in accordance with clause 16.3.
2.3 Following Probationary Period
2.3.1 Following the expiration of the Probationary Period, subject to neither party exercising the rights to terminate these Terms under clause 2.2, your employment is confirmed and may be terminated only under clause 16.
[end options]

3. Hours of Work [Delete the options which are not applicable]
[for full-time employees]
3.1 As a full-time employee, your ordinary hours of work are 40 hours per week (inclusive of two (2) reasonable Additional Hours) (Ordinary Hours).
3.2 You are required to work the Ordinary Hours over [insert number of days] days each week, [insert day] to [insert day] (inclusive), during normal business hours (Spread of Hours).
3.3 The Ordinary Hours and Spread of Hours may be varied by agreement, in writing, with the Employer, from time to time.
3.4 You may be required to work reasonable additional hours, in excess of the Ordinary Hours, as required by the Employer (Additional Hours).
3.5 [insert for Hourly Rate employees, otherwise delete] For the avoidance of doubt, the Additional Hourly Rate will apply for any Additional Hours, and generally, other payments will not be applicable.
3.6 [insert for Annual Salary Employees, otherwise delete] For the avoidance of doubt, the Annual Salary includes payment for all Additional Hours, and generally, no other payments will apply.
[for part-time employees]
3.1 As a part-time employee, your hours of work are [insert amount] hours per week (Ordinary Hours) between [insert time] and [insert time], [insert day] to [insert day] (inclusive) (Spread of Hours) plus such additional hours as the Employer may reasonably require.
3.2 The Ordinary Hours and Spread of Hours may be varied by agreement, in writing, with the Employer, from time to time.
3.3 You may be required to work reasonable additional hours, in excess of the Ordinary Hours, as required by the Employer.
3.4 [insert for Hourly Rate employees, otherwise delete] For the avoidance of doubt, the Additional Hourly Rate will apply for any Additional Hours, and generally, other payments will not be applicable.
3.5 [insert for Annual Salary Employees, otherwise delete] For the avoidance of doubt, the Annual Salary includes payment for all Additional Hours, and generally, no other payments will apply.
[for casual employees]
3.1 You are required to work casual hours as agreed. Your hours of work may be worked over any day of the week, [insert day] to [insert day], inclusive.
3.2 The Employer confirms, and you agree, that there is no firm advance commitment to continuing and indefinite work. As such: (a) you have the ability to elect to accept or reject work; (b) the Employer has the ability to elect to offer, or not offer, work; and (c) the Employer cannot guarantee that there will be future availability of continuing work with the Employer.
[end of options]

4. Remuneration [Delete the options which are not applicable]
[for full-time and part-time employees]
[Option 1 - Hourly rate employee]
4.1 You will be paid an hourly rate of $[insert pay rate] in respect of Ordinary Hours (Hourly Rate).
4.2 You will be paid an hourly rate of $[insert pay rate] in respect of Additional Hours (Additional Hourly Rate).
4.3 Where you are required to work away from your usual place of residence such that, in the Employer's reasonable opinion, it is not practicable for you to return home at the end of the working day, the Employer will arrange and pay for reasonable and suitable accommodation for the duration of the assignment. You will also be paid a travel allowance of $[insert amount] per day, including for the purpose of covering meals while you are required to work away from home.
4.4 You may also be entitled to other payments, including: penalty rates, overtime, special rates, allowances and annual leave loading (if applicable) (Other Payments).
4.5 For the avoidance of doubt, Other Payments are calculated based on the rate that may apply to you specified in the applicable modern award (if any).
[Option 2 - Annual salary inclusive of superannuation]
4.6 $[insert amount] per annum made up of superannuation contributions of $[insert amount] and the balance of $[insert amount] as cash payments (Annual Salary).
[Option 2A - insert for part-time employees only]
4.7 For the avoidance of doubt, you will be paid the appropriate pro-rata portion of the Annual Salary, according to the part-time hours that you work.
[Option 3 - Annual salary exclusive of superannuation]
4.8 You will be paid an annual base salary of $[insert amount] (Annual Salary).
[Option 3A - insert for part-time employees only]
4.9 For the avoidance of doubt, you will be paid the appropriate pro-rata portion of the Annual Salary, according to the part-time hours that you work.
[End of Full-time and Part-time Options]
4.10 Subject to the Terms, this is the total remuneration paid to you.
[for casual employees]
4.1 You will be paid an hourly rate of $[insert pay rate] (Hourly Rate).
4.2 The Hourly Rate is inclusive of an applicable casual loading amount of twenty-five (25) per cent of the Hourly Rate (Casual Loading Amount).
4.3 The Casual Loading Amount is to compensate you for not having one or more of the following entitlements: (a) paid annual leave; (b) paid personal / carer's leave; (c) paid compassionate leave; (d) payment for absence on a public holiday; (e) payment in lieu of notice of termination; and/or (f) redundancy pay.
4.4 Subject to the Terms, this is the total remuneration paid to you.
4.5 You may also be entitled to other payments, including: penalty rates, overtime, special rates and allowances (if applicable), in accordance with any applicable modern award.
[End of casual Options]
[End of Options]
4.11 The remuneration payable under these Terms (including any allowances) is intended to satisfy all entitlements to which you are or may become entitled in respect of the performance of work, under these Terms, any applicable modern award and/or the Fair Work Act 2009 (Cth) (Act).
4.12 The remuneration payable under these Terms (including any allowances) may be specifically set-off against, applied to and may otherwise absorb any existing or newly-introduced payments or benefits to which you are or may become entitled under these Terms, any applicable modern award and/or the Act, including but not limited to, minimum wage rates, overtime and penalty rates, annual leave and other loadings, weekend and other penalty rates, allowances and any other monetary entitlement which may otherwise be payable to you.

5. Superannuation [Delete the option that is not applicable]
[Option 1 - Hourly rate employees only]
In addition to your remuneration set out in clause 4, you will receive superannuation contributions in line with the minimum compulsory contribution rate required to be paid by the Employer, in accordance with applicable legislation.
[Option 2 - Salaried employees inclusive of super]
The superannuation contribution will be deducted from the Annual Salary. In the event that the amount of superannuation contribution required to be paid by law increases then the increased amount will be deducted from the Annual Salary.
[Option 3 - Salaried employees exclusive of super]
In addition to your remuneration set out in clause 4, you will receive superannuation contributions in line with the minimum compulsory contribution rate required to be paid by the Employer, in accordance with applicable legislation.

6. Expenses
The Employer will meet all reasonable expenses incurred by you in the performance of your Duties.

7. Fully Maintained Company Vehicle [Delete this clause if not applicable]
7.1 The Employer will provide you with a fully maintained company motor vehicle (Vehicle) to assist you in the proper performance of your Duties, subject to the terms set out below. The Vehicle remains the property of the Employer at all times and must be used in accordance with the Thomson Energy Property Policy and the Thomson Energy Vehicle Incident Policy.
7.2 The Employer will pay all on-road costs associated with the Vehicle, including maintenance and the costs of fuel for travel that is related to the performance of your Duties. For your use of the Vehicle, the Employer will supply you with a fuel card.
7.3 You acknowledge and agree that the Vehicle is to be used for work purposes only and not for personal use. You must not permit any unauthorised person to operate the Vehicle.
7.4 The Employer will arrange and pay for appropriate motor vehicle insurance for the Vehicle. You acknowledge and agree, however, that you are responsible for the Vehicle while it is under your control, including payment of any insurance excess applicable to at-fault claims.
7.5 You must at all times: (a) maintain a valid drivers licence in the relevant class and provide a copy to the Employer upon request; (b) keep the Vehicle clean and well-maintained (including but not limited to fuelling, checking oil levels and tire pressure); (c) comply with all insurance policy terms and conditions; (d) keep all receipts for purchases of fuel and associated Vehicle expenses and provide them to the Employer as required; and (e) promptly notify the Employer of any mechanical issues, accidents or damage to the Vehicle.
7.6 In the event of an accident, you must follow the procedures in accordance with the Thomson Energy Vehicle Incident Policy.
7.7 The Employer bears no responsibility for any fines or infringements you may incur while using the Vehicle.
7.8 You must return the Vehicle to the Employer in the event of termination of your employment, whether voluntary or involuntary, or any period where you are unable to perform your Duties, except for approved leave under these Terms.

8. Apparel
8.1 The Employer will provide you with Employer-branded apparel (Apparel) for use during the course of your employment. The Apparel remains the property of the Employer at all times and is to be worn in accordance with the Thomson Energy Property Policy.
8.2 Upon termination of employment, whether voluntary or involuntary, you must return all Apparel in reasonable condition (allowing for normal wear and tear) to the Employer on or before your final day of employment. Failure to return the Apparel may result in the cost of replacement being deducted from any final wages or otherwise recovered as permitted by law.

9. Tools and equipment
9.1 You are required to supply and maintain your own hand tools, drills, and drivers in accordance with the Employer's Thomson Energy Property Policy and Thomson Energy Tool Policy. The Employer will supply any larger or specialised tools necessary for your work (Company Tools and Equipment).
9.2 You must: (a) use Company Tools and Equipment exclusively for work-related tasks; and (b) maintain Company Tools and Equipment in good working condition at all times.
9.3 You are responsible for the safety and security of Company Tools and Equipment while in your possession. Any loss, theft, or damage to Company Tools and Equipment must be reported to management immediately.
9.4 Misuse or negligence in handling Company Tools and Equipment may result in disciplinary action.

10. Leave [Delete the options which are not applicable]
[for full-time or part-time employees]
You will be entitled to annual leave, personal/carer's leave, paid family and domestic violence leave, compassionate leave, community service leave and long service leave in accordance with applicable legislation.
[for casual employees]
You will be entitled to unpaid personal/carer's leave, compassionate leave, community service leave, and paid family and domestic violence leave and compassionate leave, in accordance with applicable legislation.
[end options]

11. The Employer's policies
11.1 You agree to be bound by the policies, written codes of conduct, and practices or procedures of the Employer (Policies) as may exist and be varied from time to time. Without limitation, this includes compliance with: (a) Thomson Energy Code of Conduct; (b) Thomson Energy Property Policy; (c) Thomson Energy Staff Training and Development Policy; (d) Thomson Energy Tool Policy; and (e) Thomson Energy Vehicle Incident Policy.
11.2 However, the Policies of the Employer do not form part of this employment agreement.

12. Compliance with laws, standards and safety requirements
You must, at all times during the course of employment, comply with all applicable Commonwealth, State and Territory laws, regulations, codes of practice, and industry standards relevant to the performance of your Duties. Without limitation, this includes compliance with: (a) all Work Health and Safety legislation, including but not limited to the Work Health and Safety Act 2011 (Cth) and the Work Health and Safety Regulations 2011 (Cth); (b) all electrical safety laws and standards; and (c) all solar (photovoltaic) system standards and requirements, and any guidelines issued by the Clean Energy Council or other relevant regulatory or accreditation body.

13. Ownership of intellectual property
13.1 The Employer owns all intellectual property that you may discover, produce or conceive which is related in any way to the Employer's business (whether or not it can be patented, can be subject to copyright or can be protected in any other way). This includes intellectual property discovered, produced or conceived: (a) during employment (whether or not it is during work hours); (b) after employment has terminated, if it is based on something you worked on or became aware of while employed by the Employer; and/or (c) by using the Employer's confidential information or its resources.
13.2 You give up any claim to that intellectual property. You agree to sign and execute all documents and give the Employer any assistance and information required to assign ownership of intellectual property in any part of the world for the Employer's exclusive benefit.
13.3 You appoint the Employer as your attorney to do anything you are required to do under this clause.
13.4 You will return all originals and copies of information to the Employer, including design, documentation, software and material relating to any intellectual property, at the Employer's request or when your employment ends. You must destroy any copies that you cannot return. You agree to confirm in writing that you have complied with this provision.
13.5 These intellectual property provisions apply both during and after the employment relationship ends.

14. Confidentiality
You agree that you will not at any time either during the continuance of your employment or after the termination of employment for any reason divulge any of the confidential information, affairs or secrets (including trade secrets) of the Employer to any other person or persons without the previous consent in writing of the Employer. You will not use or attempt to use any information which you may acquire in the course of your employment in any manner which may injure or cause loss or be calculated to injure or cause loss to the Employer.

15. Restraint
During your employment and for a period of twenty-four (24) months after the termination of your employment for any reason, you must not, directly or indirectly: (a) solicit, entice, or do business with any client, customer, or prospective client of the Employer with whom you had contact during your employment, without the Employer's prior written consent; or (b) solicit, recruit, or hire any employee of the Employer to leave their employment or engage in competing work.

16. Termination of employment [Delete the options which are not applicable]
16.1 Termination by You
[MANUAL: for full-time and part-time employees]
You may terminate your employment with the Employer by giving two (2) weeks' notice in writing to the Employer.
[MANUAL: for casual employees]
You may terminate your employment with the Employer at any time, effective at the end of your current engagement.
16.2 Termination by the Employer upon giving notice
[MANUAL: for full-time and part-time employees]
The Employer may terminate your employment with the Employer in accordance with the following table:
Employee's period of continuous service with the Employer on termination / Period
Not more than 1 year / 1 week
More than 1 year but not more than 3 years / 2 weeks
More than 3 years but not more than 5 years / 3 weeks
More than 5 years / 4 weeks
The period specified above will be increased by one (1) week if you are 45 years of age or over and have completed at least two (2) years of continuous service with the Employer.
[MANUAL: for casual employees]
Your employment may be terminated by the Employer at any time, effective at the end of your current engagement.
16.3 By the Employer without notice
The Employer may terminate your employment, effective immediately and without payment of any notice, where at any time, and provided always that procedural fairness has been followed, the Employer forms the view that you: (a) have committed any act of wilful or serious misconduct; (b) are in breach of any of the Terms; or (c) are continually or significantly neglectful of your Duties.

17. Fair Work Information Statement [Delete the options which are not applicable]
[for full-time and part-time employees]
Please find enclosed a copy of the Fair Work Information Statement.
[for casual employees]
Please find enclosed a copy of the Fair Work Information Statement and the Casual Employment Information Statement.
[end options]

We look forward to continuing a mutually rewarding working relationship with you.

Please sign and date the enclosed copy of this employment agreement to confirm acceptance of this offer of employment.

Yours sincerely
Thomson Energy Australia Pty Ltd ACN 689 985 831

Jasper Thomson
Executive Director

Acknowledgment
I, [insert employee], accept and agree to the terms and conditions of employment contained in this agreement.

Signature: ______________________
Date: ______________________
Print name: ______________________$doc$, true, true, 1),

('Thomson Energy Code of Conduct', $doc$Thomson Energy Code of Conduct

At Thomson Energy, we are dedicated to upholding the highest standards of professionalism, integrity, and respect across all operations. This Code of Conduct outlines the expected behavior from all employees to ensure a positive work environment and strong client relationships.

1. Professional Behavior
- Employees must demonstrate professionalism in all interactions, both internally and externally, reflecting the company's values.
- Communication must always be respectful. Discrimination, harassment, or the use of offensive language is strictly prohibited.
- Employees are expected to collaborate effectively, support colleagues, and foster a positive work culture.

2. Client Relations
- Employees must treat clients with respect, courtesy, and fairness in all communications and service delivery.
- A positive demeanor should be maintained, with clear, accurate, and timely information provided to clients.
- Any client concerns should be addressed promptly and escalated to management when necessary.

3. Integrity and Ethical Standards
- Employees are expected to act with honesty and transparency in all business dealings.
- Misrepresentation, false information, or any form of dishonesty is not tolerated and will be subject to disciplinary action.
- Employees must adhere to all legal and regulatory requirements at all times.

4. Compliance with Company Policies
- All employees must comply with Thomson Energy's policies, procedures, and safety standards.
- Employees are required to participate in regular training and updates to ensure adherence to safety protocols and company procedures.

5. Consequences of Misconduct
- Any breaches of this Code of Conduct will be addressed through the company's disciplinary procedures, which may include warnings, suspension, or further investigation.
- In cases of serious misconduct, especially those that damage client relationships or result in revenue loss, immediate disciplinary action, including termination, may be taken in accordance with the Fair Work Act 2009.
- Thomson Energy reserves the right to act swiftly in cases of gross misconduct, which includes actions that negatively affect client relationships or compromise the company's reputation.

6. Reporting Concerns
- Employees are encouraged to report any violations of this Code of Conduct to management, either directly or through designated reporting channels.
- All reports will be handled with confidentiality, and any form of retaliation against whistleblowers is strictly prohibited.

7. Amendment and Review
- Thomson Energy reserves the right to review, amend, or update this Code of Conduct from time to time. Employees will be notified of any changes, which will be effective immediately upon communication. It is the responsibility of each employee to stay informed of and comply with the latest version of the Code of Conduct.$doc$, true, false, 2),

('Thomson Energy Company Property Policy', $doc$Thomson Energy Company Property Policy

Purpose
The purpose of this policy is to ensure the appropriate use, maintenance, and return of company property provided to employees during their employment with Thomson Energy. This policy covers company vehicles, tools, equipment, and any other assets issued by the company.

1. Scope
This policy applies to all employees, contractors, and temporary staff who are issued company property, including vehicles, tools, and other equipment.

2. General Guidelines
- All company property is provided to employees solely for business use. It must be used responsibly, maintained in good condition, and returned upon request or termination of employment.
- Employees are expected to take reasonable care of all company property to prevent damage, loss, or theft.
- Any damage, malfunction, or loss of property must be reported immediately to management.

3. Use of Company Vehicles
- Company vehicles are provided for official business use only and must not be used for personal errands unless authorized by management.
- Employees must possess a valid driver's license to operate a company vehicle and must provide a copy to the company upon request.
- Employees are responsible for adhering to all traffic laws and regulations while operating a company vehicle.
- Vehicles must be kept clean and well-maintained. Employees are responsible for basic maintenance (e.g., fueling, checking oil, and tire pressure) and reporting any mechanical issues immediately.
- No unauthorized persons are permitted to operate company vehicles.
- Employees will be held accountable for any fines, penalties, or traffic violations incurred while operating a company vehicle.
- In the event of an accident, employees must follow the procedures outlined in the company's vehicle incident policy, which includes notifying management and completing all necessary insurance documentation.
- Employees understand that the vehicle is solely their responsibility while under their control, including any insurance excesses for at-fault claims, which the employee agrees to pay.

4. Use of Tools and Equipment
- Employees are required to supply their own hand tools, drills, and drivers as specified in the Tool Policy, while larger or specialist tools will be provided by Thomson Energy.
- All company-issued tools and equipment must be used only for work-related tasks and must be maintained in good working condition.
- Employees are responsible for the safety and security of tools and equipment while in their possession.
- Any loss, theft, or damage to tools and equipment must be reported to management immediately.
- Misuse or negligence in handling company tools or equipment may result in disciplinary action.

5. Use of Other Company Assets
- Employees may be provided with other company assets, such as laptops, phones, or safety equipment, to perform their job duties.
- All assets must be used only for business purposes, kept in good condition, and returned upon termination of employment or at management's request.
- Employees must take reasonable precautions to prevent loss or theft of assets and ensure compliance with any specific guidelines related to their use.

6. Return of Company Property
- All company property must be returned in good working condition upon termination of employment or upon request by management.
- Failure to return company property may result in deductions from the final pay, as permitted by law, or further legal action for recovery.

7. Disciplinary Action
- Any misuse, damage, loss, or unauthorized use of company property, including vehicles, tools, or equipment, may result in disciplinary action, up to and including termination of employment.

8. Amendments and Updates
- Thomson Energy reserves the right to amend or update this policy as needed. Employees will be notified of any changes, which will be effective immediately upon communication.$doc$, true, false, 3),

('Thomson Energy Staff Training and Development Policy', $doc$Thomson Energy Staff Training and Development Policy

Purpose
Thomson Energy is committed to investing in the training and development of its employees to enhance skills, improve performance, and support career growth. This policy outlines the guidelines for training opportunities, participation requirements, and the repayment obligations for early termination of employment.

1. Scope
This policy applies to all employees who participate in training programs funded or facilitated by Thomson Energy.

2. Training Opportunities
- Thomson Energy offers a variety of training programs, including but not limited to technical certifications, safety training, workshops, and professional development courses.
- Employees may be nominated for mandatory training programs based on job requirements or may request approval for additional training that benefits their role.

3. Participation and Expectations
- Employees are expected to actively participate in training sessions, complete all required coursework, and demonstrate the application of new skills in their roles.
- Employees must provide feedback on the training program to help Thomson Energy assess its effectiveness.

4. Training Costs and Financial Support
- Thomson Energy will cover the full cost of approved training, including course fees, materials, and, where applicable, travel expenses.
- Employees who receive company-sponsored training must sign an agreement acknowledging the terms of this policy, including repayment obligations for early termination.

5. Repayment Clause for Early Termination
- Employees who resign or are terminated (other than for redundancy) within 24 months of completing company-funded training will be required to repay a portion of the training costs as outlined below:
  - 0-6 months after training: 100% of training costs must be repaid.
  - 7-12 months after training: 75% of training costs must be repaid.
  - 13-18 months after training: 50% of training costs must be repaid.
  - 19-24 months after training: 25% of training costs must be repaid.
  - After 24 months, no repayment is required.
- Repayment amounts will be deducted from the employee's final paycheck, where permitted by law, or through a mutually agreed repayment plan if necessary.

6. Exemptions from Repayment
- Employees will not be required to repay training costs if their employment ends due to redundancy, ill health, or other circumstances deemed valid by Thomson Energy.
- Any disputes regarding repayment will be reviewed on a case-by-case basis by management.

7. Review and Amendments
- Thomson Energy reserves the right to review and amend this policy as needed. Employees will be notified of any changes, which will take effect immediately upon communication.$doc$, true, false, 4)
) as v(title, body, is_required, is_contract, sort_order)
where not exists (select 1 from onboarding_documents);
