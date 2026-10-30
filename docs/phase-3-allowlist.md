# Phase 3 official host allowlist evidence

Each active entry is an exact HTTPS hostname taken from a university page that supports a fit with Computer Science or a configured research interest. Hosts are not inferred from a shared parent domain. Sources were checked on 2026-10-30. The ignored private profile is the sole source of the active search-country list. A country can be searched only after its exact university host and source are reviewed and recorded here.

| Profile region | University | Exact allowed host | Official university source | Fit shown on source |
| --- | --- | --- | --- | --- |
| Canada | University of Waterloo | `uwaterloo.ca` | [Cybersecurity and Privacy Institute: Students](https://uwaterloo.ca/cybersecurity-privacy-institute/students) | Graduate research in cybersecurity, privacy, and network security |
| Australia | The University of Sydney | `www.sydney.edu.au` | [Master of Computer Science](https://www.sydney.edu.au/courses/courses/pc/master-of-computer-science.html) | MSc Computer Science with cybersecurity, AI, networks and distributed systems, and software engineering specialisations |
| China | Tsinghua University | `ac.cs.tsinghua.edu.cn` | [PhD and Master in Advanced Computing](https://ac.cs.tsinghua.edu.cn/application.html) | Graduate study in the Department of Computer Science and Technology, including 2027 enrollment information |
| Japan | Kyoto University | `www.kyoto-u.ac.jp` | [English-taught degree programs](https://www.kyoto-u.ac.jp/en/education-campus/education-and-admissions/english-taught-degree-programs) | Master's programs in Informatics include machine learning, information science, and computer engineering |
| South Korea | KAIST School of Computing | `cs.kaist.ac.kr` | [Graduate education](https://cs.kaist.ac.kr/education/graduate) | Graduate Computer Science curriculum includes systems, networks, secure computing, software design, AI, and machine learning |
| United States | University of Illinois Urbana-Champaign, Siebel School | `siebelschool.illinois.edu` | [M.S. Program](https://siebelschool.illinois.edu/academics/graduate/ms-program) | Research-oriented Master of Science in Computer Science with thesis research |
| New Zealand | University of Auckland | `www.cs.auckland.ac.nz` | [MSc Thesis in Computer Science](https://www.cs.auckland.ac.nz/courses/compsci796as1c/) | Master of Computer Science thesis and supervisor pathway |
| Switzerland | ETH Zurich | `inf.ethz.ch` | [Cyber Security master's thesis projects](https://inf.ethz.ch/studies/master/master-cybsec/thesis-and-semester-projects.html) | Computer Science department master's programme in Cyber Security and supervised security research |
| Portugal | Técnico Lisboa, University of Lisbon | `tecnico.ulisboa.pt` | [Telecommunications and Informatics Engineering](https://tecnico.ulisboa.pt/en/education/courses/masters-programmes/telecommunications-and-informatics-engineering/) | MSc covering distributed systems, network management, Internet security, AI-enabled networks, and computing |
| Italy | Politecnico di Milano | `www.polimi.it` | [Computer Science and Engineering](https://www.polimi.it/en/education/laurea-programmes/programme-detail/computer-science-and-engineering) | Current official MSc programme page; covers the active Computer Science target |

Ten active countries have verified exact hosts: Australia, Canada, China, Italy, Japan, New Zealand, Portugal, South Korea, Switzerland, and the United States. Search findings are stored locally under the ignored `outputs/` directory. They remain unverified leads and require human source review before any candidate approval. Thailand is no longer an active target; its former host is retained only as historical pilot evidence below.

## Bounded Brave pilot

On 2026-10-30, one Brave request with a maximum of three results was made for each remaining profile region, using an exact-host `site:` query. Five requests succeeded and produced 12 exact-host leads. The initial Thailand request and its first retry failed without retained failure details. The latest retry used the same three-result limit and returned sanitized HTTP 422. The response data is saved in the ignored `outputs/phase3-search-pilot.json`.

The existing safe page-fetch workflow processed the 12 saved leads sequentially. It captured exact-host official-page excerpts with retrieval timestamps for nine leads and copied 42 relevant literal sentence snippets, each with the source URL, retrieval time, and full supporting excerpt. Three page fetches failed (two China, one Italy), leaving only their search-result evidence; page-fetch failure details were not retained. The Thailand retry failed with its three-result cap unchanged; the retry failure detail was not retained. Captured excerpts did not explicitly support a professor name or email address, so none was extracted. All evidence remains `unverified`, leads remain `needs-evidence`, and `approvedForSending` remains false. No candidate was approved and no email was sent.

## Sanitized failure reporting and bounded retries

Search terms now include faculty, professor, supervisor, lab, laboratory, and research-group wording. The latest Thailand retry kept the three-result limit and returned sanitized `http_status` / HTTP 422. The three previously failed lead-page URLs were retried once each: both China pages succeeded; the Italy page at `https://www.polimi.it/formazione/formazione-oltre-la-laurea/master-universitari-e-corsi-post-laurea/dettaglio-master/3201` returned sanitized `http_status` / HTTP 404. The failed-page retry excerpts added 11 literal relevant snippets with source URLs and retrieval times.

Failure records contain only a safe category, fixed message, response-received flag, HTTP status when present, and a query-free HTTPS resource path when applicable. Brave transport diagnostics may additionally contain an allowlisted error name/cause code and syntactically safe Brave error code/request ID headers. They exclude raw exception text, API keys, response bodies, and search queries. Results remain unverified and unapproved; no email was sent.

After the four `network_error` search failures, one count-one connectivity-only Brave probe was made on 2026-10-30. The probe record was `responseReceived: false`, with no allowlisted transport code, Brave error code, or request ID available. Its cause remains undiagnosed. The probe did not retry the country searches or retain response content.

## Japan, South Korea, United States, and New Zealand pilot

On 2026-10-30, the official university sources above were checked and their exact hosts were added to the allowlist. One Brave request was then attempted per country using its country code and the existing three-result maximum. All four requests failed with sanitized `network_error` diagnostics and returned no leads. No request was retried. The ignored pilot output records the country, host, attempt time, cap, and sanitized failure only; no query, credential, or response body was retained. All four countries remain review-gated and eligible only for future discovery runs after connectivity is available.
