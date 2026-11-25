// Authored evaluation fixtures. IDs and labels are fixed separately from the production alias list.
// "true" means the initial filter should retain the job for review, independent of final fit.
export const roleGroups = [
  ['Registered nurse',[
    ['Staff RN','Deliver bedside care on an inpatient unit.',true],['Emergency Department Nurse','Current RN license required.',true],
    ['Clinical Nurse II','Provide direct inpatient nursing care.',true],['RN Case Manager','Coordinate discharge planning using an RN license.',true],
    ['Triage','Conduct remote symptom triage as a registered nurse.',true],['Nurse Navigator','Help patients coordinate treatment; RN license.',true],
    ['Advanced Practice Nurse','Requires an advanced practice license beyond an RN.',false],['Pharmacy Technician','Prepare prescriptions under supervision.',false],
    ['Radiology Technologist','Perform diagnostic imaging.',false],['Health Information Clerk','Index patient charts.',false]
  ]],
  ['Software engineer',[
    ['Backend Engineer, Identity','Build a security APIs service.',true],['Full Stack Engineer','Develop a public web portal.',true],
    ['SDE II','Design and maintain cloud services.',true],['Software Developer','Maintain scientific software.',true],
    ['Platform','Work as a software engineer maintaining deployment tooling.',true],['Applications Programmer','Implement Java applications.',true],
    ['Software Sales Manager','Lead outbound sales of software.',false],['Electrical Design Engineer','Design utility substations.',false],
    ['Technical Writer','Write API documentation.',false],['Environmental Engineer','Plan water-treatment systems.',false]
  ]],
  ['AI Infra',[
    ['Inference Performance Engineer','Optimize LLM inference and runtime latency.',true],['ML Systems Engineer','Own a distributed training stack.',true],
    ['AI Infrastructure Engineer','Operate GPU clusters.',true],['Machine Learning Platform Engineer','Deliver model serving infrastructure.',true],
    ['Infrastructure','Support ML training clusters and storage.',true],['Model Serving Developer','Deploy low-latency models.',true],
    ['Generative AI Content Lead','Lead AI content and editorial experiments.',false],['Research Recruiter','Recruit deep learning researchers.',false],
    ['Data Center Electrician','Install electrical circuits.',false],['Applied Statistician','Analyze survey trends without an infrastructure role.',false]
  ]],
  ['Product designer',[
    ['UX Designer','Design flows for a customer-facing product.',true],['Experience Designer','Design a healthcare service interface.',true],
    ['Interaction Designer','Prototype workflows in a B2B product.',true],['UI Designer','Design web application interfaces.',true],
    ['Product Design Lead','Lead interaction and visual design for the mobile app.',true],['Design','Design product details and test prototypes.',true],
    ['Industrial Product Designer','Design packaging for physical tools when the candidate preference is UI.',false],['UX Research Operations Manager','Manage interview operations.',false],
    ['Graphic Production Artist','Lay out print advertisements.',false],['Product Marketing Manager','Position products and produce campaigns.',false]
  ]],
  ['Primary school teacher',[
    ['Elementary Classroom Teacher','Teach mathematics and literacy in grade 3.',true],['Year 4 Teacher','Lead a primary classroom.',true],
    ['Primary Educator','Teach children aged 7 to 11.',true],['KS2 Classroom Teacher','Teach and supervise an elementary class.',true],
    ['Educator','Lead grade 2 literacy, math and science.',true],['Elementary Instructor','Teach core subjects in an elementary program.',true],
    ['University Lecturer','Teach graduate seminars.',false],['School Admissions Coordinator','Manage enrolment paperwork.',false],
    ['College Financial Aid Analyst','Administer aid processing.',false],['Laboratory Demonstrator','Demonstrate university experiments.',false]
  ]],
  ['Accountant',[
    ['Financial Reporting Analyst','Prepare statements and reconcile accounts.',true],['General Ledger Accountant','Prepare ledgers and journals.',true],
    ['Bookkeeper','Record accounts and reconcile invoices.',true],['Assistant Controller','Manage month-end close and reporting.',true],
    ['Accounting','Maintain ledgers for a community organization.',true],['Audit Associate','Test financial controls and verify accounts.',true],
    ['Tax Litigation Attorney','Represent clients in courts.',false],['Credit Underwriter','Review credit applications.',false],
    ['Payroll Software Seller','Sell payroll services to clients.',false],['Budget Policy Officer','Draft public-sector policy.',false]
  ]],
  ['Data analyst',[
    ['Business Intelligence Analyst','Analyze metrics and maintain dashboards.',true],['Quantitative Insights Analyst','Analyze churn and usage.',true],
    ['Analytics Analyst','Report on product cohorts.',true],['Decision Support Analyst','Run SQL reports and explain performance.',true],
    ['Analyst','Evaluate operational trends and prepare reports.',true],['Reporting Specialist','Build datasets and reports.',true],
    ['Data Privacy Counsel','Advise on data privacy regulations.',false],['Data Entry Assistant','Enter paper form data.',false],
    ['Tax Analyst','Calculate tax filings.',false],['Security Operations Analyst','Monitor cyber incident alerts.',false]
  ]],
  ['Customer support',[
    ['Customer Experience Associate','Resolve service inquiries and complaints.',true],['Customer Service Representative','Help subscribers with issues.',true],
    ['Technical Support Specialist','Troubleshoot problems for product customers.',true],['Member Services Advisor','Answer customer support questions.',true],
    ['Support','Provide email assistance for software customers.',true],['Client Care Representative','Respond to customer requests.',true],
    ['Customer Acquisition Strategist','Run acquisition campaigns.',false],['Sales Enablement Specialist','Train account executives.',false],
    ['Internal Desktop Administrator','Maintain office endpoints.',false],['Warehouse Operations Manager','Supervise the warehouse.',false]
  ]],
  ['Sales representative',[
    ['Territory Account Executive','Sell equipment in an assigned region.',true],['Business Development Representative','Qualify sales leads.',true],
    ['New Business Associate','Find customers and run sales conversations.',true],['Enterprise Sales Consultant','Sell business services.',true],
    ['Account Executive','Own a quota and sell to new clients.',true],['Sales','Represent the firm at client appointments.',true],
    ['Sales Compensation Analyst','Administer incentive plans.',false],['Retail Store Stock Associate','Sort stock and inventory.',false],
    ['Customer Onboarding Specialist','Train current customers after purchase.',false],['Web Content Editor','Edit information on a store website.',false]
  ]],
  ['Mechanic',[
    ['Auto Service Technician','Inspect and repair commercial vans.',true],['Industrial Maintenance Technician','Repair production machinery.',true],
    ['Fleet Technician','Repair trucks and maintain equipment.',true],['Automotive Mechanic','Repair and test cars.',true],
    ['Technician','Diagnose and repair vehicle engines.',true],['Heavy Equipment Service Tech','Maintain mobile machinery.',true],
    ['Mechanical Design Engineer','Design cooling systems.',false],['Insurance Claims Adjuster','Evaluate claim payments.',false],
    ['Production Scheduler','Coordinate manufacturing schedules.',false],['Parts Sales Clerk','Sell vehicle spare parts.',false]
  ]],
  ['Speech-language pathologist',[
    ['Speech and Language Pathologist','Assess communication disorders.',true],['SLP','Treat expressive-language delays.',true],
    ['Speech Therapist','Provide school speech therapy.',true],['Communication Disorders Clinician','Conduct speech and language assessment.',true],
    ['Therapist','Provide speech and language therapy in schools.',true],['Speech-Language Clinical Fellow','Practice speech-language pathology with supervision.',true],
    ['Linguistics Professor','Teach phonetics at a university.',false],['Classroom Teaching Assistant','Set up classroom materials.',false],
    ['School Psychometrician','Administer psychological tests.',false],['Hearing Instrument Seller','Sell assisted hearing products.',false]
  ]],
  ['Landscape architect',[
    ['Landscape Designer','Design public parks and garden spaces.',true],['Landscape Architecture Associate','Prepare site plans and planting plans.',true],
    ['Public Realm Designer','Design parks, recreational trails and plazas.',true],['Site Planning Associate','Produce landscape schematics.',true],
    ['Designer','Design planting layouts and urban parks.',true],['Park Design Coordinator','Prepare park designs, planting plans and illustrations.',true],
    ['Software Architect','Design distributed systems.',false],['Lawn Maintenance Worker','Mow lawns and operate trimmers.',false],
    ['Architectural Historian','Maintain a heritage register.',false],['Residential Project Scheduler','Coordinate supply delivery.',false]
  ]]
];
