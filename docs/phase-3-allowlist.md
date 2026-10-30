# Phase 3 official host allowlist evidence

Each entry is an exact HTTPS hostname taken from a university page that supports a fit with Computer Science or a configured research interest. Hosts are not inferred from a shared parent domain. Sources were checked on 2026-10-30.

| Profile region | University | Exact allowed host | Official university source | Fit shown on source |
| --- | --- | --- | --- | --- |
| Canada | University of Waterloo | `uwaterloo.ca` | [Cybersecurity and Privacy Institute: Students](https://uwaterloo.ca/cybersecurity-privacy-institute/students) | Graduate research in cybersecurity, privacy, and network security |
| Australia | The University of Sydney | `www.sydney.edu.au` | [Master of Computer Science](https://www.sydney.edu.au/courses/courses/pc/master-of-computer-science.html) | MSc Computer Science with cybersecurity, AI, networks and distributed systems, and software engineering specialisations |
| China | Tsinghua University | `ac.cs.tsinghua.edu.cn` | [PhD and Master in Advanced Computing](https://ac.cs.tsinghua.edu.cn/application.html) | Graduate study in the Department of Computer Science and Technology, including 2027 enrollment information |
| Thailand | Chulalongkorn University | `math.sc.chula.ac.th` | [Computer Science and Information Technology](https://www.math.sc.chula.ac.th/program/graduate/computer-science-information-technology/) | MSc with research groups in AI and machine learning, software engineering, and computer networking |
| Europe | ETH Zurich | `inf.ethz.ch` | [Cyber Security master's thesis projects](https://inf.ethz.ch/studies/master/master-cybsec/thesis-and-semester-projects.html) | Computer Science department master's programme in Cyber Security and supervised security research |
| Portugal | Técnico Lisboa, University of Lisbon | `tecnico.ulisboa.pt` | [Telecommunications and Informatics Engineering](https://tecnico.ulisboa.pt/en/education/courses/masters-programmes/telecommunications-and-informatics-engineering/) | MSc covering distributed systems, network management, Internet security, AI-enabled networks, and computing |
| Italy | Politecnico di Milano | `www.polimi.it` | [Master's Degree in Computer Science and Engineering](https://www.polimi.it/en/education/laurea-magistrale-programmes/programme-detail/computer-science-and-engineering-ingegneria-informatica) | MSc tracks and subjects include cybersecurity, AI, robotics, networks, and software engineering |

Search findings are stored locally under the ignored `outputs/` directory. They remain unverified leads and require human source review before any candidate approval.

## Bounded Brave pilot

On 2026-10-30, one Brave request with a maximum of three results was made for each remaining profile region, using an exact-host `site:` query. Five requests succeeded and produced 12 exact-host leads across Australia, China, Europe, Portugal, and Italy. The initial Thailand request and its single retry failed; the retry used the same three-result limit, and its failure detail was not retained. The response data is saved in the ignored `outputs/phase3-search-pilot.json`.

The existing safe page-fetch workflow processed the 12 saved leads sequentially. It captured exact-host official-page excerpts with retrieval timestamps for nine leads and copied 42 relevant literal sentence snippets, each with the source URL, retrieval time, and full supporting excerpt. Three page fetches failed (two China, one Italy), leaving only their search-result evidence; page-fetch failure details were not retained. The Thailand retry failed with its three-result cap unchanged; the retry failure detail was not retained. Captured excerpts did not explicitly support a professor name or email address, so none was extracted. All evidence remains `unverified`, leads remain `needs-evidence`, and `approvedForSending` remains false. No candidate was approved and no email was sent.
