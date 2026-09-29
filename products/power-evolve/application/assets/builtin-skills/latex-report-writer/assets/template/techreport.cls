\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{techreport}[2026/08/04 Experimental Chinese Academy technical report class]

% The experimental renderer targets XeLaTeX so that the Chinese fonts used by
% the Word template can be selected explicitly and consistently.
\PassOptionsToClass{fontset=none}{ctexart}
\LoadClass[a4paper,12pt,oneside]{ctexart}

\RequirePackage{iftex}
\ifXeTeX\else
  \ClassError{techreport}{This class must be compiled with XeLaTeX}
    {Use XeLaTeX so that Chinese fonts and the report typography are available.}
\fi

\RequirePackage{fontspec}
\RequirePackage{geometry}
\RequirePackage{setspace}
\RequirePackage{titlesec}
\RequirePackage{titletoc}
\RequirePackage{fancyhdr}
\RequirePackage{graphicx}
\RequirePackage{booktabs}
\RequirePackage{array}
\RequirePackage{longtable}
\RequirePackage{amsmath}
\RequirePackage{amssymb}
\RequirePackage{caption}
\RequirePackage{enumitem}
\RequirePackage{xcolor}
\RequirePackage{keyval}
\RequirePackage{hyperref}
\RequirePackage{indentfirst}

% A4 and the margins in technical-report-format.md.
% Header/footer distances are exposed here for later visual calibration against
% the official Word template.
\geometry{
  a4paper,
  top=30mm,
  bottom=25mm,
  left=25mm,
  right=25mm,
  headheight=15pt,
  headsep=5mm,
  footskip=10mm
}

\hypersetup{
  hidelinks,
  pdftitle={Chinese Academy Technical Report},
  pdfcreator={XeLaTeX}
}

\makeatletter

% -----------------------------------------------------------------------------
% Font policy
% -----------------------------------------------------------------------------
% Prefer common macOS names in this environment, then the Windows names used
% by the Word template and Noto CJK names. Users can override all three fonts with
% \techreportfontsetup{...}{...}{...} in the document preamble.
\IfFontExistsTF{Songti SC}{\def\TR@maincjk{Songti SC}}{%
  \IfFontExistsTF{SimSun}{\def\TR@maincjk{SimSun}}{%
    \def\TR@maincjk{Noto Serif CJK SC}%
  }%
}
\IfFontExistsTF{Heiti SC}{\def\TR@headingcjk{Heiti SC}}{%
  \IfFontExistsTF{SimHei}{\def\TR@headingcjk{SimHei}}{%
    \def\TR@headingcjk{Noto Sans CJK SC}%
  }%
}
\IfFontExistsTF{Times New Roman}{\def\TR@latin{Times New Roman}}{%
  \def\TR@latin{TeX Gyre Termes}%
}

\setmainfont{\TR@latin}
\setsansfont{\TR@latin}
\setCJKmainfont{\TR@maincjk}
\setCJKsansfont{\TR@headingcjk}
\setCJKfamilyfont{TRsong}{\TR@maincjk}
\setCJKfamilyfont{TRhei}{\TR@headingcjk}
\setCJKfamilyfont{TRtt}{\TR@maincjk}
% Match the Word template: do not insert automatic glue between CJK text and
% adjacent Latin letters or digits (e.g. 2026年8月 and 图1-1).
\xeCJKsetup{CJKecglue={\hskip 0pt}}
% fontset=none intentionally leaves these ctex aliases undefined.
\def\songti{\CJKfamily{TRsong}}
\def\heiti{\CJKfamily{TRhei}}
\def\CJKttdefault{TRtt}
\newcommand{\techreportfontsetup}[3]{%
  \setmainfont{#3}%
  \setsansfont{#3}%
  \setCJKmainfont{#1}%
  \setCJKsansfont{#2}%
  \setCJKfamilyfont{TRsong}{#1}%
  \setCJKfamilyfont{TRhei}{#2}%
  \setCJKfamilyfont{TRtt}{#1}%
}

\newcommand{\TR@bodyfont}{\songti\fontsize{12pt}{18pt}\selectfont}
\newcommand{\TR@captionfont}{\rmfamily\songti\fontsize{10.5pt}{15.75pt}\selectfont}
\newcommand{\TR@captionheadingfont}{\rmfamily\heiti\fontsize{10.5pt}{15.75pt}\selectfont}
% Table text is fifth-size Songti for CJK and fifth-size Times New Roman for
% Latin letters and Arabic numerals, with a 1.5-line baseline.
\newcommand{\reporttablefont}{\rmfamily\songti\fontsize{10.5pt}{15.75pt}\selectfont}
\newcommand{\TR@pagefont}{\songti\fontsize{10.5pt}{12pt}\selectfont}

% -----------------------------------------------------------------------------
% Report metadata
% -----------------------------------------------------------------------------
\def\TR@reportno{}
\def\TR@classno{}
\def\TR@secretlevel{}
\def\TR@projectsource{}
\def\TR@titlecn{}
\def\TR@titleen{}
\def\TR@projectname{}
\def\TR@seriesno{}
\def\TR@cooperator{}
\def\TR@reportdate{}
\def\TR@workperiod{}
\def\TR@leader{}
\def\TR@staff{}
\def\TR@writer{}
\def\TR@abstractcn{}
\def\TR@keywordscn{}
\def\TR@abstracten{}
\def\TR@keywordsen{}
\def\TR@writingunit{中国电力科学研究院有限公司}
\def\TR@coverlogo{report-logo.jpeg}

\define@key{techreport}{report-no}{\def\TR@reportno{#1}}
\define@key{techreport}{class-no}{\def\TR@classno{#1}}
\define@key{techreport}{secret-level}{\def\TR@secretlevel{#1}}
\define@key{techreport}{project-source}{\def\TR@projectsource{#1}}
\define@key{techreport}{title-cn}{\def\TR@titlecn{#1}}
\define@key{techreport}{title-en}{\def\TR@titleen{#1}}
\define@key{techreport}{project-name}{\def\TR@projectname{#1}}
\define@key{techreport}{series-no}{\def\TR@seriesno{#1}}
\define@key{techreport}{cooperator}{\def\TR@cooperator{#1}}
\define@key{techreport}{report-date}{\def\TR@reportdate{#1}}
\define@key{techreport}{work-period}{\def\TR@workperiod{#1}}
\define@key{techreport}{leader}{\def\TR@leader{#1}}
\define@key{techreport}{staff}{\def\TR@staff{#1}}
\define@key{techreport}{writer}{\def\TR@writer{#1}}
\define@key{techreport}{abstract-cn}{\def\TR@abstractcn{#1}}
\define@key{techreport}{keywords-cn}{\def\TR@keywordscn{#1}}
\define@key{techreport}{abstract-en}{\def\TR@abstracten{#1}}
\define@key{techreport}{keywords-en}{\def\TR@keywordsen{#1}}
\define@key{techreport}{writing-unit}{\def\TR@writingunit{#1}}
\define@key{techreport}{cover-logo}{\def\TR@coverlogo{#1}}
\newcommand{\techreportsetup}[1]{\setkeys{techreport}{#1}}
\newcommand{\TR@reportdatevalue}{%
  \ifx\TR@reportdate\@empty
    \number\year 年\number\month 月\number\day 日%
  \else
    \TR@reportdate
  \fi
}

% -----------------------------------------------------------------------------
% Page styles and numbering
% -----------------------------------------------------------------------------
\fancypagestyle{trfront}{%
  \fancyhf{}
  \fancyfoot[C]{\TR@pagefont\thepage}
  \renewcommand{\headrulewidth}{0pt}
  \renewcommand{\footrulewidth}{0pt}
}
\fancypagestyle{trbody}{%
  \fancyhf{}
  \fancyhead[C]{\TR@pagefont\TR@titlecn}
  \fancyfoot[C]{\TR@pagefont\thepage}
  \renewcommand{\headrulewidth}{0.4pt}
  \renewcommand{\footrulewidth}{0pt}
}
\pagestyle{empty}

\newcommand{\reportfrontmatter}{%
  \clearpage
  \pagenumbering{roman}
  \setcounter{page}{1}
  \pagestyle{trfront}%
}
\newcommand{\reportmainmatter}{%
  \clearpage
  \pagenumbering{arabic}
  \setcounter{page}{1}
  \pagestyle{trbody}%
}

% -----------------------------------------------------------------------------
% Heading and paragraph styles
% -----------------------------------------------------------------------------
\setlength{\parindent}{2em}
\setlength{\parskip}{0pt}
\setstretch{1.5}
% Legacy amsmath displays keep zero extra glue. Generated reports use the
% reportequation block below, which controls visible edge-to-edge clearance
% explicitly instead of relying on TeX's height-dependent baseline glue.
\AtBeginDocument{%
  \setlength{\abovedisplayskip}{0pt}%
  \setlength{\abovedisplayshortskip}{0pt}%
  \setlength{\belowdisplayskip}{0pt}%
  \setlength{\belowdisplayshortskip}{0pt}%
}
\setcounter{secnumdepth}{3}
\setcounter{tocdepth}{3}

\titleformat{\section}
  {\heiti\fontsize{15pt}{22.5pt}\selectfont}
  {\thesection}{1em}{}
\titleformat{\subsection}
  {\heiti\fontsize{14pt}{21pt}\selectfont}
  {\thesubsection}{1em}{}
\titleformat{\subsubsection}
  {\heiti\fontsize{12pt}{18pt}\selectfont}
  {\thesubsubsection}{1em}{}
% These asymmetric TeX skips compensate for the different visible top/bottom
% bearings of the body and heading fonts.  In the compiled PDF they produce an
% approximately equal 18pt ink-edge clearance on both sides of body-adjacent
% headings.  The transition corrections below prevent adjacent heading skips
% from accumulating while preserving the body-adjacent calibration.
\titlespacing*{\section}{0pt}{6pt}{9.87pt}
\titlespacing*{\subsection}{0pt}{0.31pt}{9.65pt}
\titlespacing*{\subsubsection}{0pt}{3.08pt}{9.23pt}
\newcommand{\reportsectiontosubsectiongap}{\vspace{-9.70pt}}
\newcommand{\reportsubsectiontosubsubsectiongap}{\vspace{-7.59pt}}
% The formal rule requires each level-1 heading to start on a new page.
\newcommand{\sectionbreak}{\clearpage}

% Fonts and line spacing for generated TOC entries.
\renewcommand{\contentsname}{}
\dottedcontents{section}[2.5em]{}{1.5em}{1em}
\dottedcontents{subsection}[4.5em]{}{2.5em}{1em}
\dottedcontents{subsubsection}[7.5em]{}{3.5em}{1em}

% -----------------------------------------------------------------------------
% Cover and approval page
% -----------------------------------------------------------------------------
\newlength{\TR@metaWidth}
\newlength{\TR@metaA}
\newlength{\TR@metaB}
\newlength{\TR@metaC}
\newcommand{\TR@covermetadata}{%
  \begingroup
  \setstretch{1.15}%
  \heiti\fontsize{10.5pt}{14pt}\selectfont
  \settowidth{\TR@metaA}{报告编号：\TR@reportno}%
  \settowidth{\TR@metaB}{分类号：\TR@classno}%
  \settowidth{\TR@metaC}{密级：\TR@secretlevel}%
  \setlength{\TR@metaWidth}{\TR@metaA}%
  \ifdim\TR@metaB>\TR@metaWidth\setlength{\TR@metaWidth}{\TR@metaB}\fi
  \ifdim\TR@metaC>\TR@metaWidth\setlength{\TR@metaWidth}{\TR@metaC}\fi
  % The reference cover leaves a small inset between the metadata block and
  % the right text margin; it is not flush-right with the page body.
  \noindent\hspace*{\dimexpr\textwidth-\TR@metaWidth-10mm\relax}%
  \begin{minipage}{\TR@metaWidth}
    \raggedright
    报告编号：\TR@reportno\par
    分类号：\TR@classno\par
    密级：\TR@secretlevel
  \end{minipage}
  \endgroup
}

\newcommand{\makecover}{%
  \begin{titlepage}
    \thispagestyle{empty}
    \noindent
    \begin{minipage}[t]{0.58\textwidth}
      \vspace{-4.2mm}%
      \includegraphics[width=82.4mm]{\TR@coverlogo}%
    \end{minipage}%
    \hfill
    \begin{minipage}[t]{0.37\textwidth}
      \vspace{35.5mm}%
      \TR@covermetadata
    \end{minipage}
    \par
    % The report title block belongs in the middle-upper area of the cover.
    \vspace{15mm}
    \begin{center}
      \ifx\TR@projectsource\@empty\else
        {\heiti\fontsize{15pt}{22pt}\selectfont \TR@projectsource\par}
        \vspace{-1mm}
      \fi
      {\heiti\fontsize{18pt}{27pt}\selectfont \TR@titlecn\par}
      \ifx\TR@titleen\@empty\else
        % Keep the English report title directly below the Chinese title.
        \vspace{2mm}
        {\rmfamily\fontsize{16pt}{24pt}\selectfont \TR@titleen\par}
      \fi
      \ifx\TR@projectname\@empty\else
        \vspace{0mm}
        {\heiti\fontsize{15pt}{22pt}\selectfont \TR@projectname\par}
      \fi
      \ifx\TR@seriesno\@empty\else
        \vspace{4mm}
        {\heiti\fontsize{15pt}{22pt}\selectfont \TR@seriesno\par}
      \fi
    \end{center}
    \vfill
    \begin{center}
      {\heiti\fontsize{14pt}{20pt}\selectfont
        \TR@writingunit\par
        \ifx\TR@cooperator\@empty\else
          \TR@cooperator\par
        \fi
        \TR@reportdatevalue\par}
    \end{center}
  \end{titlepage}%
}

\newcommand{\TR@approvalline}[2]{%
  \noindent #1\hspace{1em}#2\par
}
\newcommand{\TR@approvalindentedline}[2]{%
  \noindent\hspace*{3em}#1\hspace{1em}#2\par
}
\newlength{\TR@approvalFieldIndent}
\newcommand{\TR@approvalcooperator}{%
  \ifx\TR@cooperator\@empty
    合作（协作）单位名称%
  \else
    \TR@cooperator%
  \fi
}
\newcommand{\TR@approvalcooperatorline}{%
  \ifx\TR@cooperator\@empty\else
    \noindent\hspace*{\TR@approvalFieldIndent}%
    \parbox[t]{\dimexpr\textwidth-\TR@approvalFieldIndent\relax}{\raggedright\TR@approvalcooperator\par}%
    \par
  \fi
}
\newcommand{\TR@approvalblank}{\vspace{\baselineskip}}
\newcommand{\makeapproval}{%
  \clearpage
  \thispagestyle{empty}
  % The supplied approval-page template uses its own A4 text area.
  \newgeometry{top=25.4mm,bottom=25.4mm,left=31.7mm,right=31.7mm}%
  \begingroup
  % Force the bold series explicitly for all CJK, Latin, and numeric glyphs.
  \songti\fontseries{b}\selectfont\fontsize{14pt}{18pt}\selectfont
  \setlength{\parindent}{0pt}
  \setlength{\parskip}{0pt}
  \settowidth{\TR@approvalFieldIndent}{工作单位：}%
  \addtolength{\TR@approvalFieldIndent}{1em}%
  \TR@approvalline{工作单位：}{\TR@writingunit}
  \TR@approvalcooperatorline
  \TR@approvalblank
  \TR@approvalline{工作时间：}{\TR@workperiod}
  \TR@approvalline{项目负责人：}{\TR@leader}
  \TR@approvalline{工作人员：}{\TR@staff}
  \TR@approvalline{报告编写：}{\TR@writer}
  \TR@approvalblank
  \TR@approvalblank
  \noindent\TR@writingunit\par
  \TR@approvalindentedline{报告审核：}{}
  \TR@approvalindentedline{学术技术分委会：}{}
  \TR@approvalindentedline{部\hspace{2em}门：}{}
  \TR@approvalindentedline{科技部/咨询业务部（格式审核）：}{}
  \TR@approvalindentedline{学术技术委员会：}{}
  \TR@approvalblank
  \TR@approvalindentedline{报告批准}{}
  \TR@approvalindentedline{副院长/总工程师/院长助理/副总工程师：}{}
  \endgroup
  \restoregeometry
}

% -----------------------------------------------------------------------------
% Abstract and table of contents
% -----------------------------------------------------------------------------
\newcommand{\makeabstract}{%
  \clearpage
  \thispagestyle{trfront}
  \begingroup
  \setlength{\parindent}{2em}
  \setstretch{1.5}
  \begin{center}
    {\heiti\fontsize{18pt}{27pt}\selectfont 内容摘要\par}
  \end{center}
  \vspace{3mm}
  {\songti\fontsize{12pt}{18pt}\selectfont \hspace*{2em}\TR@abstractcn\par}
  {\songti\fontsize{12pt}{18pt}\selectfont \hspace*{2em}关键词：\TR@keywordscn\par}
  \endgroup

  \clearpage
  \thispagestyle{trfront}
  \begingroup
  \setlength{\parindent}{2em}
  \setstretch{1.5}
  \vspace{9mm}
  \begin{center}
    {\rmfamily\fontsize{18pt}{27pt}\selectfont ABSTRACT\par}
  \end{center}
  \vspace{3mm}
  {\rmfamily\fontsize{12pt}{18pt}\selectfont \hspace*{2em}\TR@abstracten\par}
  {\rmfamily\fontsize{12pt}{18pt}\selectfont \hspace*{2em}KEYWORDS: \TR@keywordsen\par}
  \endgroup
}

\newcommand{\makereporttoc}{%
  \clearpage
  \thispagestyle{trfront}
  \begingroup
  \setlength{\parindent}{0pt}
  \begin{center}
    {\heiti\fontsize{18pt}{27pt}\selectfont 目  录\par}
  \end{center}
  % Keep exactly one fourth-size Heiti leading between the title and the
  % first contents entry. Calling \tableofcontents here would add ctex's
  % hidden section-heading spacing on top of the explicit title.
  {\heiti\fontsize{14pt}{21pt}\selectfont\vspace{\baselineskip}}
  \@starttoc{toc}
  \endgroup
}

% -----------------------------------------------------------------------------
% Figures, tables and equations
% -----------------------------------------------------------------------------
\renewcommand{\figurename}{图}
\renewcommand{\tablename}{表}
\counterwithin{figure}{section}
\counterwithin{table}{section}
\renewcommand{\thefigure}{\thesection-\arabic{figure}}
\renewcommand{\thetable}{\thesection-\arabic{table}}
\numberwithin{equation}{section}
\renewcommand{\theequation}{\thesection-\arabic{equation}}

% Standard display math cannot keep the visible formula-to-prose clearance
% stable because its interline glue depends on formula height. Build each
% generated equation as one vertical-list box and use separately calibrated
% skips above and below. In the current Songti/CM math combination these values
% bring the visible gaps close to the roughly 9.7pt ink gap between adjacent
% body lines, while leaving extra tolerance above tall fractions.
\newlength{\TR@equationaboveclearance}
\newlength{\TR@equationbelowclearance}
\newlength{\TR@equationtagwidth}
\newlength{\TR@equationavailablewidth}
\newsavebox{\TR@equationcontent}
\setlength{\TR@equationaboveclearance}{10.5pt}
\setlength{\TR@equationbelowclearance}{12.15pt}
\newcommand{\TR@equationtag}{%
  {\TR@captionfont（\theequation）}%
}
\NewDocumentEnvironment{reportequation}{+b}{%
  \par
  \penalty\predisplaypenalty
  \nointerlineskip
  \vskip\TR@equationaboveclearance
  \nobreak
  \refstepcounter{equation}%
  % Reserve a dedicated right-hand column for the equation number. If the
  % formula is still too wide, scale only the formula into the remaining
  % column so the number can never overlap it.
  \sbox{\TR@equationcontent}{$\displaystyle #1$}%
  \settowidth{\TR@equationtagwidth}{\TR@equationtag}%
  \setlength{\TR@equationavailablewidth}{\dimexpr\textwidth-\TR@equationtagwidth-1em\relax}%
  \hbox to \textwidth{%
    \ifdim\wd\TR@equationcontent>\TR@equationavailablewidth
      \makebox[\TR@equationavailablewidth][c]{%
        \resizebox{\TR@equationavailablewidth}{!}{\usebox{\TR@equationcontent}}}%
    \else
      \makebox[\TR@equationavailablewidth][c]{\usebox{\TR@equationcontent}}%
    \fi
    \hspace{1em}%
    \makebox[\TR@equationtagwidth][r]{\TR@equationtag}%
  }%
  \nobreak
  \nointerlineskip
  \vskip\TR@equationbelowclearance
  \nointerlineskip
}{%
}

\DeclareCaptionFont{TRcaption}{\rmfamily\heiti\fontsize{10.5pt}{15.75pt}\selectfont}
\captionsetup{
  font=TRcaption,
  labelfont=TRcaption,
  labelsep=space,
  justification=centering,
  singlelinecheck=false
}
\captionsetup[table]{position=top}
\captionsetup[figure]{position=bottom,skip=0pt,aboveskip=0pt,belowskip=0pt}
% Match figure/table-to-body clearance to the 12pt, 1.5-line body leading.
\setlength{\floatsep}{18pt}
\setlength{\textfloatsep}{18pt}
\setlength{\intextsep}{18pt}
\setlength{\dblfloatsep}{18pt}
\setlength{\dbltextfloatsep}{18pt}

\newcommand{\TR@figurelabel}[1]{图#1}
\newcommand{\TR@tablelabel}[1]{表#1}
% Figure number and title are separated by one full-width-character em.
\DeclareCaptionLabelFormat{TRfigurelabel}{\TR@figurelabel{#2}\hspace{1em}}
\captionsetup[figure]{labelformat=TRfigurelabel,labelsep=none}

% Placeholder keeps the figure above its caption and allocates a real figure
% counter, so later labels/references use the same number as the visible text.
\newcommand{\reportfigureplaceholder}[1]{%
  \begin{figure}[htbp]
    \setlength{\parindent}{0pt}%
    \setlength{\parskip}{0pt}%
    \centering
    \refstepcounter{figure}%
    \addcontentsline{lof}{figure}{\TR@figurelabel{\thefigure}\ #1}%
    \fcolorbox{gray}{white}{%
      \parbox[c][38mm][c]{0.72\textwidth}{%
        \centering\color{gray}\rmfamily\songti\fontsize{10.5pt}{15.75pt}\selectfont
        【此处插入\TR@figurelabel{\thefigure}】}}
    \par\nointerlineskip
    {\centering\TR@captionheadingfont \TR@figurelabel{\thefigure}\hspace{1em}#1\par}
  \end{figure}%
}

\newcommand{\reporttablecaption}[1]{%
  \refstepcounter{table}%
  \addcontentsline{lot}{table}{\TR@tablelabel{\thetable}\hspace{1em}#1}%
  \noindent{\TR@captionheadingfont \TR@tablelabel{\thetable}\hspace{1em}#1\par}%
  % Keep one fifth-size 1.5-line leading between the caption line and the
  % table rule. This is explicit inter-element spacing, not caption parskip.
  \vspace{0pt}%
}
% Preserve the body paragraph's current leading before a table without
% changing the body line spacing or the table caption's own zero parskip.
\newcommand{\reporttablebefore}{%
  \par\addvspace{18pt}%
}
% Resume body text after a table with the same body leading used before it.
\newcommand{\reporttableafter}{%
  \par\addvspace{18pt}%
}
\newcommand{\reporttablenote}[1]{%
  \noindent{\TR@captionfont 注：#1\par}%
}

% Use full-width Chinese parentheses for equation numbers, e.g. （1-1）.
\def\tagform@#1{\maketag@@@{（\ignorespaces#1\unskip\@@italiccorr）}}

\newenvironment{symbols}{%
  \par\noindent\hspace*{2em}{\TR@bodyfont 式中：}\par
}{\par}
\newcommand{\symbolitem}[2]{%
  \noindent\hspace*{2em}{\TR@bodyfont #1——#2}\par
}

% -----------------------------------------------------------------------------
% Appendices and references
% -----------------------------------------------------------------------------
\newcommand{\reportappendices}{%
  \clearpage
  \pagestyle{trbody}%
  \setcounter{section}{0}
  \setcounter{subsection}{0}
  \setcounter{subsubsection}{0}
  \renewcommand{\thesection}{\Alph{section}}
  \renewcommand{\thesubsection}{\thesection\arabic{subsection}}
  \renewcommand{\thesubsubsection}{\thesubsection.\arabic{subsubsection}}
}
\newcommand{\appendixsection}[1]{%
  \clearpage
  \thispagestyle{trbody}%
  \refstepcounter{section}%
  \setcounter{subsection}{0}
  \setcounter{subsubsection}{0}
  \begin{center}
    {\heiti\fontsize{15pt}{22.5pt}\selectfont 附录\ \thesection\ #1\par}
  \end{center}
  \thispagestyle{trbody}%
  \addcontentsline{toc}{section}{附录\ \thesection\ #1}
}

\newcounter{TRbib}
\newenvironment{reportbibliography}{%
  \clearpage
  \setcounter{TRbib}{0}
  \begin{center}
    {\heiti\fontsize{15pt}{22.5pt}\selectfont 参考文献\par}
  \end{center}
  \addcontentsline{toc}{section}{参考文献}
  \begin{list}{}{%
    \setlength{\leftmargin}{0pt}%
    \setlength{\labelwidth}{0pt}%
    \setlength{\labelsep}{0pt}%
    \setlength{\itemindent}{2em}%
    \setlength{\parsep}{0pt}%
    \setlength{\itemsep}{0pt}%
    \setlength{\listparindent}{0pt}%
  }
}{%
  \end{list}
}
\newcommand{\reportbibitem}[1]{%
  \refstepcounter{TRbib}%
  \item[\hspace*{-2em}[\theTRbib]]{\TR@bodyfont\hspace{1em}#1}%
}

\makeatother
