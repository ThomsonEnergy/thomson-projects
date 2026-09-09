-- Migration 093: rename existing prebuilds and rewrite client-facing descriptions
-- to align with the new naming/description standard (short, human-readable name;
-- "SUPPLY AND INSTALL NEW ..." title + trade-language paragraph description,
-- scoped strictly to actual components, no qualification-level language).
--
-- Already applied directly via Supabase MCP execute_sql on 2026-09-09 - this file
-- is kept for the record, not meant to be re-run.

update prebuilds set name = 'AC Isolator', client_description = 'SUPPLY AND INSTALL NEW AC ISOLATOR

Supply and installation of an AC isolator switch at the required location, including running and terminating the associated cabling, in accordance with AS/NZS 3000.' where id = 'b669fcd2-2e40-4f56-9ba8-a9bba037d59b';

update prebuilds set name = 'Batten Light', client_description = 'SUPPLY AND INSTALL NEW LED BATTEN LIGHT

Supply and installation of an LED batten light fitting, including running and terminating cabling to the fitting and mounting in the required location, in accordance with AS/NZS 3000.' where id = 'b23d69c9-10cc-4043-80ea-ffa75f866258';

update prebuilds set name = 'Data Cable', client_description = 'SUPPLY AND INSTALL NEW DATA CABLE

Supply and installation of CAT6A data cable, run to the required location and terminated ready for connection, in accordance with relevant industry standards.' where id = '40b1ea50-89f3-43e0-bcb9-e9316b48b7c8';

update prebuilds set name = 'Data Outlet', client_description = 'SUPPLY AND INSTALL NEW DATA OUTLET

Supply and installation of a data outlet, including running and terminating CAT6A cabling and fitting the RJ45 outlet and cover plate at the required location, in accordance with relevant industry standards.' where id = '45e6079c-e0cf-4c75-952c-f9d5df14899e';

update prebuilds set name = 'Solar Panel Disconnect/Reconnect (Additional Panel)', client_description = 'DISCONNECT AND RECONNECT SOLAR PANELS (ADDITIONAL PANEL)

Disconnect and safely isolate the solar system, remove and store the additional panel(s) as required, then reinstall and recommission once other works are complete. Price charged per panel, in accordance with AS/NZS 5033 and AS/NZS 3000.' where id = '25e086a0-20a8-4ccd-8f05-8c42d853f228';

update prebuilds set name = '90mm LED Downlight', client_description = 'SUPPLY AND INSTALL NEW 90MM LED DOWNLIGHT

Supply and installation of a 90mm LED downlight, including running and terminating cabling to the fitting and connecting via a twist-connect surface socket, in accordance with AS/NZS 3000.' where id = '7e190388-1a38-4d37-8e79-b54cb34206d2';

update prebuilds set name = 'Client-Supplied Pendant Install', client_description = 'INSTALL CLIENT-SUPPLIED PENDANT LIGHT

Installation of a client-supplied pendant light fitting, including connection and termination to the existing circuit and mounting in the required location, in accordance with AS/NZS 3000.' where id = 'fc28d12b-c5df-43c7-9427-52313d362990';

update prebuilds set name = 'Ceiling Sweep Fan', client_description = 'SUPPLY AND INSTALL NEW CEILING SWEEP FAN

Supply and installation of a ceiling sweep fan, including connection and termination to the existing circuit and mounting to the ceiling structure, in accordance with AS/NZS 3000.' where id = '32c231a0-6090-415a-ab88-acadc3f70c91';

update prebuilds set name = 'Extraction Fan with Light', client_description = 'SUPPLY AND INSTALL NEW EXTRACTION FAN WITH LIGHT

Supply and installation of a ducted extraction fan with integrated LED light, including running and terminating cabling, connecting a run-on timer, and mounting the unit in the required location, in accordance with AS/NZS 3000.' where id = '9005d25c-be57-4bd0-9145-6ee246bb1ee2';

update prebuilds set name = 'Oyster Light', client_description = 'SUPPLY AND INSTALL NEW OYSTER LIGHT

Supply and installation of an oyster light fitting, including running and terminating cabling to the fitting and mounting to the ceiling, in accordance with AS/NZS 3000.' where id = '8512bd64-9495-4dbf-ac59-ef92171086bb';

update prebuilds set name = 'Pool Light Kit', client_description = 'SUPPLY AND INSTALL NEW POOL LIGHT KIT

Supply and installation of a pool light kit (two lights with driver), including running and terminating the low-voltage cabling to each fitting, in accordance with AS/NZS 3000.' where id = '8ed1731c-0364-4196-b1b0-44bd4f868de5';

update prebuilds set name = 'Point-to-Point Data Bridge', client_description = 'SUPPLY AND INSTALL NEW POINT-TO-POINT DATA BRIDGE

Supply and installation of a point-to-point wireless data bridge, including running and terminating data cabling and mounting and configuring the bridge units, in accordance with relevant industry standards.' where id = 'dc14722a-3244-4f6b-9c47-e33b0b6bb83f';

update prebuilds set name = 'Wall Light (Up/Down)', client_description = 'SUPPLY AND INSTALL NEW WALL LIGHT (UP/DOWN)

Supply and installation of an up/down wall light fitting, including running and terminating cabling to the fitting and mounting to the wall, in accordance with AS/NZS 3000.' where id = '2b6a882b-d660-4f2d-b813-d5c1ca2ebabb';

update prebuilds set name = 'Vanity Wall Light', client_description = 'SUPPLY AND INSTALL NEW VANITY WALL LIGHT

Supply and installation of a vanity wall light fitting, including running and terminating cabling to the fitting and mounting above the vanity, in accordance with AS/NZS 3000.' where id = '496b7aed-7143-4f3b-9c16-16c20cc9511d';

update prebuilds set name = 'Consumer Mains (Per Metre)', client_description = 'SUPPLY AND INSTALL NEW CONSUMER MAINS IN CONDUIT (PER METRE)

Supply and installation of consumer mains cable enclosed in conduit, run and fixed to the building structure as required, sized and installed in accordance with AS/NZS 3000 and AS/NZS 3008.' where id = 'e53a0b08-85ee-496e-8770-45af737becac';

update prebuilds set name = 'Solar DC Circuit (Per Metre)', client_description = 'SUPPLY AND INSTALL NEW SOLAR DC CIRCUIT (PER METRE)

Supply and installation of solar DC circuit cabling enclosed in conduit, run and fixed to the building structure as required, sized and installed in accordance with AS/NZS 5033, AS/NZS 5139, AS/NZS 3000 and AS/NZS 3008.' where id = 'e8cf4dc1-4a54-4b6c-8cd9-82df0c9184ae';

update prebuilds set name = 'Solar Inverter Installation', client_description = 'SUPPLY AND INSTALL NEW SOLAR INVERTER

Supply and installation of a solar inverter, including running and terminating AC cabling, fitting an AC isolator switch, and connecting DC inputs via MC4 connectors, in accordance with AS/NZS 5033, AS/NZS 5139 and AS/NZS 3000.' where id = '5bd878db-c7f8-4058-ad0a-a9bb8c25e0c4';

update prebuilds set name = '90mm LED Downlight (New Build)', client_description = 'SUPPLY AND INSTALL NEW 90MM LED DOWNLIGHT (NEW BUILD)

Supply and installation of a 90mm LED downlight as part of a new build fit-off, including running and terminating cabling to the fitting, in accordance with AS/NZS 3000.' where id = 'f6aad58b-78e1-44d7-b62c-a57efbc61d3c';

update prebuilds set name = 'LED Strip Light', client_description = 'SUPPLY AND INSTALL NEW LED STRIP LIGHT

Supply and installation of an LED strip light in an aluminium mounting profile, including running and terminating cabling and fixing the profile in the required location, in accordance with AS/NZS 3000.' where id = 'ee7d90bd-4efa-4706-a1e1-ae7c195363de';

update prebuilds set name = '32A Circuit (Per Metre)', client_description = 'SUPPLY AND INSTALL NEW 32A CIRCUIT (PER METRE)

Supply and installation of a new 32A circuit, cable run and terminated as required, sized and installed in accordance with AS/NZS 3000 and AS/NZS 3008.' where id = 'e8ccdc0d-1abc-4a94-ba27-3b40a7638cb7';

update prebuilds set name = 'Light Circuit (Per Metre)', client_description = 'SUPPLY AND INSTALL NEW LIGHT CIRCUIT (PER METRE)

Supply and installation of a new lighting circuit, cable run and terminated as required, sized and installed in accordance with AS/NZS 3000 and AS/NZS 3008.' where id = '4131c038-6394-4af2-8df1-12f29acd747d';

update prebuilds set name = 'Light Dimmer', client_description = 'SUPPLY AND INSTALL NEW LIGHT DIMMER

Supply and installation of a light dimmer mechanism, connected and terminated to the existing circuit and fitted in the required location, in accordance with AS/NZS 3000.' where id = '1a714a0f-7be9-4e7f-bf2f-04ffce1a7ce6';

update prebuilds set name = 'Light Switch', client_description = 'SUPPLY AND INSTALL NEW LIGHT SWITCH

Supply and installation of a new light switch, including running and terminating cabling and fitting the switch mechanism and cover in the required location, in accordance with AS/NZS 3000.' where id = '5e9d1d4e-186c-423a-9220-2854b378487d';

update prebuilds set name = 'Light Switch Mechanism', client_description = 'SUPPLY AND INSTALL NEW LIGHT SWITCH MECHANISM

Supply and installation of a light switch mechanism, connected and terminated to the existing circuit and fitted in the required location, in accordance with AS/NZS 3000.' where id = '8e3963c9-fb59-48f8-bc64-3082513c8f6e';

update prebuilds set name = 'Light Switch Plate', client_description = 'SUPPLY AND INSTALL NEW LIGHT SWITCH PLATE

Supply and installation of a light switch plate, connected and terminated to the existing switch mechanism and fitted in the required location, in accordance with AS/NZS 3000.' where id = 'a33d3f0a-bbb0-4eb7-a00e-27aa00dad5ab';

update prebuilds set name = 'Power Circuit (Per Metre)', client_description = 'SUPPLY AND INSTALL NEW POWER CIRCUIT (PER METRE)

Supply and installation of a new power circuit, cable run and terminated as required, sized and installed in accordance with AS/NZS 3000 and AS/NZS 3008.' where id = 'ebfad6d8-384f-4119-a086-ef561aa4795a';

update prebuilds set name = 'Power Circuit in Conduit (Per Metre)', client_description = 'SUPPLY AND INSTALL NEW POWER CIRCUIT IN CONDUIT (PER METRE)

Supply and installation of a new power circuit enclosed in conduit, run and fixed to the building structure as required, sized and installed in accordance with AS/NZS 3000 and AS/NZS 3008.' where id = 'd261d0da-3ac7-41a7-bc0f-772b725624cc';

update prebuilds set name = 'Power Circuit in Vertical Wall (Per Metre)', client_description = 'SUPPLY AND INSTALL NEW POWER CIRCUIT IN VERTICAL WALL (PER METRE)

Supply and installation of a new power circuit run within a vertical wall cavity, cable run and terminated as required, sized and installed in accordance with AS/NZS 3000 and AS/NZS 3008.' where id = 'c89a804c-0dbc-45c4-8560-31f7bff46e67';

update prebuilds set name = 'Fan Run-On Timer', client_description = 'SUPPLY AND INSTALL NEW FAN RUN-ON TIMER

Supply and installation of a fan run-on timer within the wall cavity, connected and terminated to the existing fan and light circuit, in accordance with AS/NZS 3000.' where id = '1c81a9b1-f572-4693-83f7-9c331d16d22b';

update prebuilds set name = 'Emergency Light', client_description = 'SUPPLY AND INSTALL NEW EMERGENCY LIGHT

Supply and installation of an emergency lighting fitting, including running and terminating cabling to the fitting and mounting in the required location, ensuring correct operation in both normal and emergency modes, in accordance with AS/NZS 3000.' where id = 'c94aa5c2-8dac-4d26-8554-4708a32babc4';

update prebuilds set name = 'Extraction Fan', client_description = 'SUPPLY AND INSTALL NEW EXTRACTION FAN

Supply and installation of a ducted extraction fan, including running and terminating cabling, connecting a run-on timer, and mounting the unit in the required location, in accordance with AS/NZS 3000.' where id = '21c96242-44a0-4732-aad7-54eadd62f734';

update prebuilds set name = 'Ceiling Fan (Residential)', client_description = 'SUPPLY AND INSTALL NEW CEILING FAN

Supply and installation of a residential ceiling fan, including connection and termination to the existing circuit and mounting to the ceiling structure, in accordance with AS/NZS 3000.' where id = '54074b93-38f6-4ae6-9168-767bd5c7f9de';

update prebuilds set name = 'Flood/Sensor Light', client_description = 'SUPPLY AND INSTALL NEW FLOOD/SENSOR LIGHT

Supply and installation of a flood or sensor light fitting, including running and terminating cabling to the fitting and mounting in the required location, in accordance with AS/NZS 3000.' where id = '14251059-5d0f-4e22-a057-4716dcc4814d';

update prebuilds set name = 'Garden Light', client_description = 'SUPPLY AND INSTALL NEW GARDEN LIGHT

Supply and installation of a garden spike light, including running and terminating low-voltage cabling to the fitting, in accordance with AS/NZS 3000.' where id = '3de8254d-916b-4605-9480-b81b06d0b2d7';

update prebuilds set name = 'Garden Lighting Driver', client_description = 'SUPPLY AND INSTALL NEW GARDEN LIGHTING DRIVER

Supply and installation of a driver suitable for a garden lighting system, connected and terminated to the existing cabling and mounted in a suitable protected location, in accordance with AS/NZS 3000.' where id = 'a5d53f42-6a00-436e-9893-fb46cbba24b5';

update prebuilds set name = 'Generator Inlet', client_description = 'SUPPLY AND INSTALL NEW GENERATOR INLET

Supply and installation of a generator inlet at the required location, connected and terminated to the existing switchboard, in accordance with AS/NZS 3000.' where id = '438fa20e-b9d7-4820-aaf0-7d3ccebf7e97';

update prebuilds set name = 'Double 10A GPO', client_description = 'SUPPLY AND INSTALL NEW DOUBLE 10A GPO

Supply and installation of a double 10A general power outlet, connected and terminated to the existing circuit and fitted in the required location, in accordance with AS/NZS 3000.' where id = '6827237b-7e98-476b-8b0b-d6ed139f5dbc';

update prebuilds set name = 'Weatherproof Double 10A GPO', client_description = 'SUPPLY AND INSTALL NEW WEATHERPROOF DOUBLE 10A GPO

Supply and installation of a weatherproof double 10A general power outlet, connected and terminated to the existing circuit and fitted in the required location, in accordance with AS/NZS 3000.' where id = '53969165-8f26-4201-8b47-3c2ef11abf7b';

update prebuilds set name = 'High Bay Light', client_description = 'SUPPLY AND INSTALL NEW HIGH BAY LIGHT

Supply and installation of a high bay light fitting, including running and terminating cabling, installing suspension via jack chain, and mounting the fitting at the required height, in accordance with AS/NZS 3000.' where id = '428791c1-7738-4d73-a4e6-505c19b9225c';

update prebuilds set name = 'Hot Water System Connection', client_description = 'ELECTRICAL CONNECTION OF NEW HOT WATER SYSTEM

Electrical connection of a hot water system at the required location, including running and terminating cabling and fitting an isolation switch, in accordance with AS/NZS 3000.' where id = '566902d6-ab32-4163-80b9-73ced686c1ef';

update prebuilds set name = 'Industrial Outlet', client_description = 'SUPPLY AND INSTALL NEW INDUSTRIAL OUTLET

Supply and installation of an industrial outlet, including running and terminating cabling and fitting the switched socket outlet in the required location, in accordance with AS/NZS 3000.' where id = '6c5acd6c-ca4d-44ed-849d-db814e1380f3';

update prebuilds set name = 'Solar Panel Installation', client_description = 'SUPPLY AND INSTALL NEW SOLAR PANEL

Supply and installation of a solar panel, including fitting mounting rail, clamps and roof brackets, in accordance with AS/NZS 5033 and AS/NZS 3000.' where id = 'c3c5b013-0f05-40cf-87bc-2f1cecac226f';

update prebuilds set name = 'Lighting Track', client_description = 'SUPPLY AND INSTALL NEW LIGHTING TRACK

Supply and installation of a lighting track system, including mounting hardware and suspension kit, fixed and aligned ready for connection, in accordance with AS/NZS 3000.' where id = '48442855-1b5e-4944-b902-aed99fb270ba';

update prebuilds set name = 'Meter Board', client_description = 'SUPPLY AND INSTALL NEW METER BOARD

Supply and installation of a new meter board, connected and terminated to the existing circuits and mounted to ensure a neat, protected and compliant installation, in accordance with AS/NZS 3000.' where id = '4c1efe65-36b0-43e6-9268-ca73b24077e7';

update prebuilds set name = 'Motion Sensor', client_description = 'SUPPLY AND INSTALL NEW MOTION SENSOR

Supply and installation of a motion sensor, including running and terminating cabling to the fitting and mounting in the required location, in accordance with AS/NZS 3000.' where id = '63070641-ace8-4568-9c75-06d8da6dad1d';

update prebuilds set name = 'RCBO Installation', client_description = 'SUPPLY AND INSTALL NEW RCBO

Supply and installation of a new RCBO suitable for the existing circuit, terminated to manufacturer specifications and tested, in accordance with AS/NZS 3000.' where id = '00c08033-0343-4dac-bb5f-402cde01b302';

update prebuilds set name = 'Smoke Alarm', client_description = 'SUPPLY AND INSTALL NEW SMOKE ALARM

Supply and installation of a hardwired smoke alarm, connected and terminated to the existing circuit and mounted in the required location, in accordance with AS/NZS 3000.' where id = 'cce4b621-ac7e-4547-bdbf-664c486e9590';

update prebuilds set name = 'DC Battery Cable (70mm)', client_description = 'SUPPLY AND INSTALL NEW DC BATTERY CABLE

Supply and installation of DC battery cabling (positive + negative) enclosed in conduit, run and fixed to building structure, compliant with AS/NZS 5139, AS/NZS 5033, AS/NZS 3000 and sized to AS/NZS 3008.' where id = 'd50a5b00-2afd-4917-be87-78aa8b86b83c';

update prebuilds set name = 'Solar Panel Disconnect/Reconnect (Up to 10 Panels)', client_description = 'DISCONNECT, REMOVE AND REINSTALL SOLAR PANELS (ROOF REPLACEMENT)

Disconnect and isolate the solar system safely at the inverter, remove panels and mounting rail from the affected roof section and store securely on site, then reinstall using the existing rail, cabling and panels once roofing works are complete. Price includes up to 10 panels, in accordance with AS/NZS 5033 and AS/NZS 3000.' where id = '95b06331-4325-4066-9e32-92d60fe4fc2b';

update prebuilds set name = 'DC Battery Circuit Breaker', client_description = 'SUPPLY AND INSTALL NEW DC BATTERY CIRCUIT BREAKER

Supply and installation of one DC battery circuit breaker, mounted and terminated with bolt-on lugs and tested, in accordance with AS/NZS 5139, AS/NZS 5033 and AS/NZS 3000.' where id = '2fa4a264-73d5-455e-84bb-8ff27ce4892c';

update prebuilds set name = 'Solar Rail & Cabling (Per Panel)', client_description = 'SUPPLY NEW SOLAR MOUNTING RAIL & DC CABLING (PER PANEL)

Supply of new mounting rail and DC cabling to replace existing, charged per panel. Allowance for rail and DC cabling only, in accordance with AS/NZS 5033 and AS/NZS 3000.' where id = 'f808c973-16e9-4b62-9200-829d3fcc9f0f';

update prebuilds set name = '10kW Single-Phase Sigenergy Inverter', client_description = 'SUPPLY AND INSTALL NEW 10KW SINGLE-PHASE SIGENERGY INVERTER

Supply and installation of one 10kW single-phase Sigenergy inverter as part of a solar PV installation, including mounting, AC and DC cabling, protection devices and isolators, commissioned and tested, in accordance with AS/NZS 5033, AS/NZS 5139 and AS/NZS 3000.' where id = 'dd2c4a8c-c509-4366-958e-36269df065c1';

update prebuilds set name = 'Surface-Mount Switchboard', client_description = 'SUPPLY AND INSTALL NEW SURFACE-MOUNT SWITCHBOARD

Supply and installation of a new surface-mounted switchboard, connected and terminated to the existing circuits and mounted to ensure a neat, protected and compliant installation, in accordance with AS/NZS 3000.' where id = '5c6d6acf-edcc-4198-acee-5eb56a521d95';

update prebuilds set name = 'Track Light Fitting', client_description = 'SUPPLY AND INSTALL NEW TRACK LIGHT FITTING

Supply and installation of a track-mounted light fitting to an existing track system, positioned and adjusted to achieve the required illumination, in accordance with AS/NZS 3000.' where id = '140769da-449f-4ea4-a34d-64376afd32a5';

update prebuilds set name = 'WiFi Access Point', client_description = 'SUPPLY AND INSTALL NEW WIFI ACCESS POINT

Supply and installation of a WiFi access point, mounted, connected and configured at the nominated location, in accordance with relevant industry standards.' where id = '540bf048-1c07-4ba0-9551-ac4b6c3182e8';
