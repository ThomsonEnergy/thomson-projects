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
- **STC count (DCCEEW schedule, confirmed 6 Nov 2026):** STCs = usable kWh (first 50 kWh only) x the factor for the install period, rounded down. Flat factor 9.3 to 31 Dec 2025 and 8.4 from 1 Jan to 30 Apr 2026. From 1 May 2026 the count is tiered: 0 to 14 kWh at 100% of the factor, over 14 to 28 kWh at 60%, over 28 to 50 kWh at 15%. Factor by period: 6.8 May to Dec 2026, 5.7 Jan to Jun 2027, 5.2 Jul to Dec 2027, 4.6 Jan to Jun 2028, 4.1 Jul to Dec 2028, 3.6 Jan to Jun 2029, 3.1 Jul to Dec 2029, 2.6 Jan to Jun 2030, 2.1 Jul to Dec 2030. TEops will work this out from the design's usable kWh (backlog item 58, waiting on yes); until then type the count on the quote.

## 2. On the quote (NETCC, same as solar)

- Battery make, model and usable kWh, and the inverter it pairs with (Pylon pull, "Your system" page on the proposal). Pylon's `storage_kwh` is the nominal size, not the usable: a SigenStor BAT 10.0 is 9.04 kWh nominal and 8.76 kWh usable, so ten read 90.4 in Pylon and 87.6 usable. The STCs are paid on the usable figure on the CEC approved product list.
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

- The tier percentages and the factor schedule above are from the DCCEEW Cheaper Home Batteries page (6 Nov 2026). Check the CER calculator at install time; the regulator's figure is the one that is paid.
- Confirm which staff hold the SAA GCBS class and record it in Settings > Team with "battery" in the licence name.

## Sources

- [DCCEEW: Cheaper Home Batteries Program](https://www.dcceew.gov.au/energy/programs/cheaper-home-batteries)
- [CER: Changes to the Cheaper Home Batteries Program (December 2025)](https://cer.gov.au/news-and-media/news/2025/december/changes-to-cheaper-home-batteries-program)
- [CER: solar battery inspection checklist](https://cer.gov.au/document/solar-battery-inspection-checklist-0)
- [Solar Accreditation Australia: about accreditation](https://saaustralia.com.au/about-accreditation/)
- [Solar Choice: changes from 1 May 2026](https://www.solarchoice.net.au/learn/solar-rebates/government-battery-rebate/changes-1-may-2026/)
- [Formbay battery guide pack](https://formbay.com.au/battery-guide-pack)
