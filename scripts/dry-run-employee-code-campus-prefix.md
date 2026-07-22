# Employee code campus-prefix dry run

**No DB writes.** Review this file, then approve before running the rename.

## Proposed rule

| Campus (DB) | DB campus_code | New prefix | Example |
|---|---|---|---|
| Gulistan-e-Johar Campus | JHR | **GEJ** | `02-1955` → `GEJ-02-1955` |
| Kaneez Fatima Campus | KNF | **GKF** | `02-1955` → `GKF-02-1955` |
| North Nazimabad Campus | NNZ | **NNN** | `02-1955` → `NNN-02-1955` |

## Summary

- **Gulistan-e-Johar Campus (id=1, prefix=GEJ)**: 87 employees — 85 to rename, 2 skipped
- **Kaneez Fatima Campus (id=2, prefix=GKF)**: 12 employees — 12 to rename, 0 skipped
- **North Nazimabad Campus (id=3, prefix=NNN)**: 7 employees — 7 to rename, 0 skipped
- **UNASSIGNED (campus_id null)**: 14 employees — 0 to rename, 14 skipped

- **Total to rename:** 104
- **Total skipped:** 16
- **Duplicate proposed codes:** 0
- **Proposed code collides with existing kept code:** 0

## Gulistan-e-Johar Campus — prefix `GEJ`

| id | full_name | old_code | new_code | status |
|---:|---|---|---|---|
| 154 | NIMLA ASAD MIRZA | `01-00017` | `GEJ-01-00017` | rename |
| 145 | SUKAINA KIZILBASH | `01-00018` | `GEJ-01-00018` | rename |
| 152 | ASAD HUSSAIN MIRZA | `01-00019` | `GEJ-01-00019` | rename |
| 151 | MUHAMMAD HUSSAIN MIRZA | `01-2000` | `GEJ-01-2000` | rename |
| 168 | FATIMA HUSSAIN | `01-2005` | `GEJ-01-2005` | rename |
| 153 | FOZIA HUSSAIN | `01-2006` | `GEJ-01-2006` | rename |
| 155 | ASIFA OWAIS | `01-2009` | `GEJ-01-2009` | rename |
| 131 | MAHRUKH BALOCH | `02-001138` | `GEJ-02-001138` | rename |
| 91 | UME - FARWA | `02-001166` | `GEJ-02-001166` | rename |
| 94 | SHAZMAH | `02-001192` | `GEJ-02-001192` | rename |
| 101 | SHABANA ASHFAQ | `02-001197` | `GEJ-02-001197` | rename |
| 150 | SYEDA ANITA HAIDER | `02-001214` | `GEJ-02-001214` | rename |
| 110 | LUBNA SABHEEH | `02-001219` | `GEJ-02-001219` | rename |
| 148 | LAIRULLANA MASOOD | `02-001231` | `GEJ-02-001231` | rename |
| 111 | SADIYA SAMI | `02-001248` | `GEJ-02-001248` | rename |
| 92 | LAIBA IRFAN | `02-001264` | `GEJ-02-001264` | rename |
| 122 | FATIMA USMAN | `02-001271` | `GEJ-02-001271` | rename |
| 123 | FARAH SOHAIL | `02-001273` | `GEJ-02-001273` | rename |
| 93 | MUSARAT BEGUM | `02-001291` | `GEJ-02-001291` | rename |
| 102 | KHUSHBOO | `02-001311` | `GEJ-02-001311` | rename |
| 112 | AMMARA HASSAN | `02-001337` | `GEJ-02-001337` | rename |
| 124 | SYEDA SABIKAH HASSAN NAQVI | `02-001338` | `GEJ-02-001338` | rename |
| 134 | FARHEEN HAIDER | `02-001339` | `GEJ-02-001339` | rename |
| 126 | BUSHRA IJAZ | `02-001348` | `GEJ-02-001348` | rename |
| 113 | NABEEHA IFTIKHAR | `02-001352` | `GEJ-02-001352` | rename |
| 103 | MADIHA SHOAIB | `02-001355` | `GEJ-02-001355` | rename |
| 95 | FATIMA RAFIQ | `02-001358` | `GEJ-02-001358` | rename |
| 135 | FAIZA KHAN | `02-001359` | `GEJ-02-001359` | rename |
| 104 | ASMA NAZ | `02-001365` | `GEJ-02-001365` | rename |
| 136 | HABIB-UDDIN | `02-001375` | `GEJ-02-001375` | rename |
| 137 | SYEDA GHAZALA | `02-001376` | `GEJ-02-001376` | rename |
| 114 | SEHAR ZAIDI | `02-001383` | `GEJ-02-001383` | rename |
| 138 | ABDULLAH SIDDIQUI | `02-001388` | `GEJ-02-001388` | rename |
| 96 | HERA QURESHI | `02-001404` | `GEJ-02-001404` | rename |
| 106 | AMNA SHAHZADI | `02-001405` | `GEJ-02-001405` | rename |
| 107 | KAINAT WILSON | `02-001406` | `GEJ-02-001406` | rename |
| 115 | SHAISTA BANO | `02-001407` | `GEJ-02-001407` | rename |
| 141 | JASMINE NUSRAT | `02-001413` | `GEJ-02-001413` | rename |
| 108 | NADIA SULEMAN | `02-001414` | `GEJ-02-001414` | rename |
| 97 | SABA SHAIKH | `02-001417` | `GEJ-02-001417` | rename |
| 116 | NAILA NAZ | `02-001420` | `GEJ-02-001420` | rename |
| 117 | AVESHA KHAN | `02-001424` | `GEJ-02-001424` | rename |
| 127 | SABA ABDUL GHAFFAR | `02-001427` | `GEJ-02-001427` | rename |
| 118 | ANUM AKRAM | `02-001428` | `GEJ-02-001428` | rename |
| 125 | SHEREEN MEENA | `02-001435` | `GEJ-02-001435` | rename |
| 109 | UMAMA ALI | `02-001439` | `GEJ-02-001439` | rename |
| 128 | SIR IQBAL AHMED | `02-001468` | `GEJ-02-001468` | rename |
| 98 | MOZMA WASEEM | `02-001470` | `GEJ-02-001470` | rename |
| 119 | MARJAN | `02-001471` | `GEJ-02-001471` | rename |
| 129 | REENA KUMARI RAJPOT | `02-001475` | `GEJ-02-001475` | rename |
| 99 | AREEBA AZHAR | `02-001476` | `GEJ-02-001476` | rename |
| 130 | ZAHIDA BEGUM | `02-00644` | `GEJ-02-00644` | rename |
| 147 | MIRZA TAHIR ABBAS | `02-00836` | `GEJ-02-00836` | rename |
| 132 | MUHAMMAD RASHID QURESHI | `02-00983` | `GEJ-02-00983` | rename |
| 121 | ANJUM BASHIR | `02-0593` | `GEJ-02-0593` | rename |
| 120 | SARAH KAUSAR | `02-0635` | `GEJ-02-0635` | rename |
| 90 | SYED AZMAT AHMED | `02-0861` | `GEJ-02-0861` | rename |
| 149 | BUSHRA WASIM | `02-0924` | `GEJ-02-0924` | rename |
| 157 | SAJIDA RUBAB ADIL | `03-00125` | `GEJ-03-00125` | rename |
| 156 | OWAIS AHMED SHAH | `03-00174` | `GEJ-03-00174` | rename |
| 160 | ALI SAJJAD | `03-00190` | `GEJ-03-00190` | rename |
| 161 | AMIR ALI | `03-00237` | `GEJ-03-00237` | rename |
| 164 | MARTIN IMAMDIN | `03-00318` | `GEJ-03-00318` | rename |
| 146 | SULTANA AMIR | `03-00325` | `GEJ-03-00325` | rename |
| 159 | IMTIAZ HUSSAIN | `03-00331` | `GEJ-03-00331` | rename |
| 142 | AMBREEN FATIMA | `03-00451` | `GEJ-03-00451` | rename |
| 170 | SYED KOMAIL HASSAN ZAIDI | `03-00486` | `GEJ-03-00486` | rename |
| 158 | SYEDA MAHEEN ZEHRA | `03-00489` | `GEJ-03-00489` | rename |
| 172 | SAJEELA SALMAN | `03-00547` | `GEJ-03-00547` | rename |
| 169 | SHAKERA SHAKEEL | `03-00556` | `GEJ-03-00556` | rename |
| 139 | SYEDA SARA NAQVI | `03-00557` | `GEJ-03-00557` | rename |
| 105 | AYESHA ALI | `03-00579` | `GEJ-03-00579` | rename |
| 171 | MISHAL REHAN | `03-00580` | `GEJ-03-00580` | rename |
| 162 | MURTAZA HUSSAIN | `03-00591` | `GEJ-03-00591` | rename |
| 173 | ASIA MUJEEB | `03-00603` | `GEJ-03-00603` | rename |
| 140 | SANA ZAKA | `03-00608` | `GEJ-03-00608` | rename |
| 163 | S. JOHN HASSAN RIZVI | `03-00612` | `GEJ-03-00612` | rename |
| 174 | AMNA MASROOR | `03-00615` | `GEJ-03-00615` | rename |
| 165 | BINISH FATIMA | `03-00636` | `GEJ-03-00636` | rename |
| 144 | HIRA KHADIM | `03-00639` | `GEJ-03-00639` | rename |
| 166 | HAFSA MUSHTAQ | `03-00643` | `GEJ-03-00643` | rename |
| 167 | UMAMA SHAFIQ | `03-00644` | `GEJ-03-00644` | rename |
| 143 | ALI ASGHAR MIRZA | `03-1937` | `GEJ-03-1937` | rename |
| 133 | ZOHAIR INAYAT HUSSAIN | `05-00031` | `GEJ-05-00031` | rename |
| 100 | SOHAIL KHAN | `05-2011` | `GEJ-05-2011` | rename |
| 175 | MUHAMMAD HASSAN MIRZA | `EMP-MHM-001` | `—` | skip_legacy_prefix |
| 184 | Hashir Khan | `TEST-HASHIR-001` | `—` | skip_legacy_prefix |

## Kaneez Fatima Campus — prefix `GKF`

| id | full_name | old_code | new_code | status |
|---:|---|---|---|---|
| 185 | ALISHBA AHMED | `02-00010` | `GKF-02-00010` | rename |
| 186 | AMBREEN UZAIR | `02-00011` | `GKF-02-00011` | rename |
| 187 | HUSNIA RAHEEM | `02-00014` | `GKF-02-00014` | rename |
| 188 | SANA BATOOL | `02-00015` | `GKF-02-00015` | rename |
| 189 | ATIQA SAEED | `02-00018` | `GKF-02-00018` | rename |
| 190 | SYEDA RUBAB NAQVI | `02-00019` | `GKF-02-00019` | rename |
| 191 | ASBAH BATOOL | `02-00020` | `GKF-02-00020` | rename |
| 193 | SHAKEELA | `04-0050118` | `GKF-04-0050118` | rename |
| 194 | TASLEEEM | `04-005051` | `GKF-04-005051` | rename |
| 195 | AZRA RIAZ | `04-005062` | `GKF-04-005062` | rename |
| 201 | SHOAIB ISMAIL | `04-2001` | `GKF-04-2001` | rename |
| 202 | SONIA CINDERILLA | `04-2002` | `GKF-04-2002` | rename |

## North Nazimabad Campus — prefix `NNN`

| id | full_name | old_code | new_code | status |
|---:|---|---|---|---|
| 203 | AYESHA | `02-1940` | `NNN-02-1940` | rename |
| 204 | MUQADDAS JABIN | `02-1953` | `NNN-02-1953` | rename |
| 205 | FOZIA NIGHAT | `02-1955` | `NNN-02-1955` | rename |
| 206 | MEHAK MUBASHIRA | `02-1966` | `NNN-02-1966` | rename |
| 207 | AIMAN IMRAN | `02-1967` | `NNN-02-1967` | rename |
| 208 | JAVAIRA SHAHZAD | `02-1970` | `NNN-02-1970` | rename |
| 209 | SAMREEN IRFAN | `02-1971` | `NNN-02-1971` | rename |

## UNASSIGNED — no campus_id (will NOT be renamed)

| id | full_name | old_code | new_code | status |
|---:|---|---|---|---|
| 192 | BENAZIR WASEEM | `02-001481` | `—` | skip_no_campus |
| 178 | SHAFIQUE HUSSAIN | `04-00143` | `—` | skip_no_campus |
| 179 | SAQLAIN ABBAS | `04-00151` | `—` | skip_no_campus |
| 181 | HASSAN RAZA | `04-0050110` | `—` | skip_no_campus |
| 183 | ZEESHAN ABBAS | `04-0050113` | `—` | skip_no_campus |
| 180 | TAJ MUHAMMAD | `04-0050115` | `—` | skip_no_campus |
| 182 | MUHAMMAD ARIF | `04-0050116` | `—` | skip_no_campus |
| 177 | HIDAYATULLAH | `04-005052` | `—` | skip_no_campus |
| 176 | NUSTRAT RAHAT | `04-005081` | `—` | skip_no_campus |
| 196 | ALI HAIDER | `06-00562` | `—` | skip_no_campus |
| 197 | SALEEM ULLAH | `06-00564` | `—` | skip_no_campus |
| 198 | GHULAM HAIDER | `06-00572` | `—` | skip_no_campus |
| 199 | ABID HUSSAIN KHUSA | `06-00573` | `—` | skip_no_campus |
| 200 | MUHAMMAD AHMED | `06-00575` | `—` | skip_no_campus |
