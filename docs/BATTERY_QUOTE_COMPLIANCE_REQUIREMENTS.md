# Battery quote compliance requirements: Cheaper Home Batteries Program, SAA and AS/NZS 5139

Written 21 Oct 2026 for backlog item 24 (Battery proposals). Same purpose as `SOLAR_QUOTE_COMPLIANCE_REQUIREMENTS.md`: what a battery quote must capture before it goes out, and what the job must record before it is complete, so the federal discount is not lost and the install is legal. The rules in code (`netlify/functions/_shared/solar-compliance-rules.js`, battery sections) and the pre-quote questions (`public/js/template-questions.js`, battery set) are distilled from this page. Update this page first, then the code.

Three things apply on top of the solar rules:

1. **Cheaper Home Batteries Program** (federal, from 1 July 2025, run by the Clean Energy Regulator through the Small-scale Renewable Energy Scheme). The discount arrives as STCs on the battery, shown to the client as the STC credit on the Investment summary.
2. **Solar Accreditation Australia (SAA)** accreditation for the designer and installer. SAA runs three classes: grid connected PV (GCPV), grid connected battery systems (GCBS) and stand-alone power systems (SPS), each as Design, Install, or Design and Install. Battery work needs the GCBS class. Only an SAA accredited person's design and install work creates STCs.
3. **AS/NZS 5139:2019** (electrical installations, safety of battery systems for use with power conversion equipment): where the battery may go, clearances, signage, and the system types the CER inspection checklist is organised by.

## 1. Program eligibility (what the quote must check)

- **Battery size:** 5 to 100 kWh usable capacity. The discount is paid on the first 50 kWh only.
- **Approved product:** the battery (and the inverter it pairs with) must be on the Clean Energy Council approved product list on the day of installation. The list changes, so check at quoting and again at ordering.
- **VPP capable:** the battery, or the inverter when the battery is not, must be able to join a virtual power plant. It does not have to join one.
- **Solar first:** the battery must be installed with new or existing solar PV, and commissioned on or after the solar is commissioned. A battery with no solar is not eligible.
- **One per premises:** only one battery system per premises can claim. A second or an upgrade at the same address cannot claim again.
- **Accredited people:** designed and installed (or supervised) by an SAA accredited person with the GCBS class; electrical work by a licensed electrician.
- **Stacking:** state rebates or loans may be added where the state allows it (NSW's own battery incentive was folded into the federal program; check the current state position when quoting).
- **STC count:** from 1 May 2026 the STCs are tiered by battery size and the factor drops every six months instead of yearly (industry sources quote a factor of 6.8 per usable kWh for May to December 2026 and 5.7 from 1 January 2027, with the first 14 kWh at the full factor, 14 to 28 kWh at a reduced rate and 28 to 50 kWh at a small rate). TEops does not calculate battery STCs: type the count on the stage ("Number of STCs"), taken from Pylon or Formbay, and the credit is count x $ per STC.

## 2. On the quote (NETCC, same as solar)

- Battery make, model and usable kWh, and the inverter it pairs with (Pylon pull, "Your system" page on the proposal).
- Which circuits are backed up in a blackout and which are not.
- Where the battery goes and that the spot meets AS/NZS 5139.
- Full price inc GST, deposit, the STC credit being applied, and validity.
- Warranty terms for the battery and the inverter.
- The designer's and installer's SAA accreditation numbers.

## 3. AS/NZS 5139 location rules (what the pre-quote questions ask)

- Not inside a habitable room (bedroom, living room, kitchen), and not in a ceiling space or under a stairway or in an escape route.
- Not within the clearances to windows, doors, vents or hot water units set by the standard; a fire-rated barrier is needed where the wall backs onto a habitable room.
- Within the battery's temperature range (shaded outside or a ventilated garage, never a hot tin shed with no airflow).
- Signage at the main switchboard and at the battery; an isolator within reach.
- The CER's battery inspection checklist sorts systems into pre-assembled integrated BESS, pre-assembled battery system, and other (sections 4, 5 and 6 of the standard); the installer picks the right one at commissioning.

## 4. Before the job can be complete (STC creation)

- NMI and exact address.
- Battery and inverter serial numbers (Installed equipment card).
- Photo of the installed location showing clearances and signage.
- Installer's and designer's SAA numbers and the electrician's licence number.
- Signed owner and installer declarations with the fixed compliant wording.
- CCEW, then the Formbay battery (BSTC) job lodged.

## 5. What TEops does with this (item 24)

- Battery proposal type, and "Batteries as well" on a Solar proposal, both ask the battery question set (usable kWh, backup, coupling, location to AS/NZS 5139, VPP, CEC list, first claim, solar first, state rebate, internet).
- Ready-to-send gate: a battery quote cannot be emailed or moved to Quote Sent while a battery rule fails, unless Admin or Finance send anyway with a reason (kept on the quote and in the activity log).
- Job tasks on approval: CEC list check at ordering, GCBS accreditation check, DNSP application, VPP and monitoring registration, location photo, serials, Formbay battery job.
- Staff licences: a Team licence named with "SAA" and "battery" (for example "SAA GCBS battery design and install") is what the gate looks for.

## Open points for the owner

- The 1 May 2026 tier percentages above come from installer and retailer pages, not from the regulations: check the CER page before quoting a battery STC count by hand.
- Confirm which staff hold the SAA GCBS class and record it in Settings > Team with "battery" in the licence name.

## Sources

- [DCCEEW: Cheaper Home Batteries Program](https://www.dcceew.gov.au/energy/programs/cheaper-home-batteries)
- [CER: Changes to the Cheaper Home Batteries Program (December 2025)](https://cer.gov.au/news-and-media/news/2025/december/changes-to-cheaper-home-batteries-program)
- [CER: solar battery inspection checklist](https://cer.gov.au/document/solar-battery-inspection-checklist-0)
- [Solar Accreditation Australia: about accreditation](https://saaustralia.com.au/about-accreditation/)
- [Solar Choice: changes from 1 May 2026](https://www.solarchoice.net.au/learn/solar-rebates/government-battery-rebate/changes-1-may-2026/)
- [Formbay battery guide pack](https://formbay.com.au/battery-guide-pack)
