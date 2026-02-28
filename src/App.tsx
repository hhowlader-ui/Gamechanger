import React, { useState, useEffect } from 'react';

export default function App() {
  const [chApiKey, setChApiKey] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [companyNumber, setCompanyNumber] = useState('');
  
  const [loading, setLoading] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [error, setError] = useState('');
  const [results, setResults] = useState<any[]>([]);

  const steps = [
    "Authenticating secure server",
    "Fetching Companies House records",
    "Locating Statement of Affairs",
    "Downloading secure PDF",
    "Analyzing financials with Gemini AI",
    "Formatting final data"
  ];

  useEffect(() => {
    const savedChKey = localStorage.getItem('CH_API_KEY');
    const savedGemKey = localStorage.getItem('GEMINI_API_KEY');
    if (savedChKey) setChApiKey(savedChKey);
    if (savedGemKey) setGeminiApiKey(savedGemKey);
  }, []);

  const saveApiKeys = () => {
    localStorage.setItem('CH_API_KEY', chApiKey);
    localStorage.setItem('GEMINI_API_KEY', geminiApiKey);
    alert("Keys Saved Successfully!");
  };

  const handleExtract = async () => {
    if (!chApiKey || !geminiApiKey) {
      setError("Please set both API Keys in the sidebar.");
      return;
    }
    if (!companyNumber) {
      setError("Please enter a valid Company Number.");
      return;
    }

    setLoading(true);
    setError('');
    setActiveStep(1);
    
    try {
      const authHeader = { 'Authorization': `Basic ${btoa(chApiKey.trim() + ':')}` };

      // Step 1: Fetch CH Details via Vite Proxy
      const detailsRes = await fetch(`/api/ch/company/${companyNumber}`, { headers: authHeader });
      if (!detailsRes.ok) throw new Error("Could not find this Company Number in Companies House.");
      const details = await detailsRes.json();

      // Step 2: Fetch Filing History
      setActiveStep(2);
      const historyRes = await fetch(`/api/ch/company/${companyNumber}/filing-history`, { headers: authHeader });
      const history = await historyRes.json();

      let soaMeta = null;
      for (const item of history.items || []) {
        if (item.category === 'statement-of-affairs' || (item.description && item.description.includes('resolution'))) {
          soaMeta = item.links?.document_metadata;
          if (soaMeta) break;
        }
      }
      if (!soaMeta) throw new Error("No Statement of Affairs found in the filing history.");

      // Step 3: Download Secure PDF
      setActiveStep(3);
      const pdfRes = await fetch('/api/pdf', {
        headers: {
          'x-target-url': soaMeta,
          'x-api-key': chApiKey.trim()
        }
      });
      const pdfData = await pdfRes.json();
      if (!pdfData.success) throw new Error(`PDF Download failed: ${pdfData.error}`);

      // Step 4: Analyze with Gemini API directly
      setActiveStep(4);
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${geminiApiKey.trim()}`;
      const geminiPrompt = `Extract the liquidation data from this Statement of Affairs PDF. 
      Find Total Assets (estimated to realise), ODLA (Overdrawn Director Loan Account), Total Deficiency, BBL/CBILS (Bank loans), HMRC Preferential, HMRC Unsecured, and Trade Creditors.
      Also find the Accountant Name or Firm. If not found, return 'Not Found' or '0'.
      Return JSON STRICTLY matching this structure:
      {"total_assets": "...", "odla": "...", "total_deficiency": "...", "bbl_cbils": "...", "hmrc_preferential": "...", "hmrc_unsecured": "...", "trade_creditors": "...", "accountant_firm": "..."}`;

      const aiResponse = await fetch(geminiUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: geminiPrompt }, { inlineData: { mimeType: 'application/pdf', data: pdfData.base64 } }] }],
          generationConfig: { temperature: 0.0, responseMimeType: "application/json" }
        })
      });

      const aiData = await aiResponse.json();
      if (!aiResponse.ok) throw new Error(`Gemini Error: ${aiData.error?.message}`);

      // Step 5: Format Data
      setActiveStep(5);
      let extractedData = {};
      try { extractedData = JSON.parse(aiData.candidates[0].content.parts[0].text); } 
      catch (e) { throw new Error("Gemini successfully read the document but failed to output a clean table."); }

      setResults([{
        companyNumber,
        companyName: details.company_name || 'N/A',
        ...extractedData
      }, ...results]);
      
      setActiveStep(6);

    } catch (err: any) {
      setError(`Extraction Failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-slate-50 font-sans text-slate-800 overflow-hidden">
      <aside className="w-80 bg-slate-900 text-slate-300 flex flex-col shadow-2xl z-20">
        <div className="p-8 border-b border-slate-800">
          <h1 className="text-3xl font-extrabold text-white tracking-tight">Liq<span className="text-blue-500">Pro</span></h1>
          <p className="text-xs text-slate-500 mt-2 uppercase tracking-widest font-semibold">Extraction Engine</p>
        </div>
        <div className="p-8 flex-1 space-y-6">
          <h2 className="text-sm font-bold text-white uppercase tracking-wider mb-4">Configuration</h2>
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-400">Companies House API Key</label>
            <input type="password" placeholder="Live REST Key..." className="w-full bg-slate-800 border border-slate-700 rounded-md p-3 text-sm text-white outline-none focus:border-blue-500 transition-colors" value={chApiKey} onChange={(e) => setChApiKey(e.target.value)} />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-400">Gemini Pro API Key</label>
            <input type="password" placeholder="AI Studio Key..." className="w-full bg-slate-800 border border-slate-700 rounded-md p-3 text-sm text-white outline-none focus:border-blue-500 transition-colors" value={geminiApiKey} onChange={(e) => setGeminiApiKey(e.target.value)} />
          </div>
          <button onClick={saveApiKeys} className="w-full mt-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-sm font-semibold py-3 rounded-md transition-all">Save Keys Locally</button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col h-screen overflow-y-auto">
        <div className="max-w-6xl w-full mx-auto p-10 space-y-8">
          
          <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
            <h2 className="text-2xl font-bold text-slate-800 mb-6">New Extraction</h2>
            <div className="flex gap-4">
              <input type="text" placeholder="Enter Company Number (e.g., 11969947)" className="flex-1 text-lg p-4 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all" value={companyNumber} onChange={(e) => setCompanyNumber(e.target.value)} disabled={loading} />
              <button onClick={handleExtract} disabled={loading} className={`px-10 py-4 text-lg font-bold text-white rounded-xl shadow-lg transition-all ${loading ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 hover:shadow-blue-500/30'}`}>
                {loading ? 'Processing...' : 'Extract Data'}
              </button>
            </div>
            {error && <div className="mt-6 bg-red-50 border-l-4 border-red-500 p-4 rounded-r-xl text-red-800 text-sm font-mono shadow-sm">⚠️ {error}</div>}
          </div>

          {loading && (
            <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
              <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-6">Extraction Progress</h3>
              <div className="space-y-4">
                {steps.map((step, idx) => (
                  <div key={idx} className={`flex items-center gap-4 ${idx > activeStep ? 'opacity-30' : 'opacity-100'} transition-opacity duration-300`}>
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${idx < activeStep ? 'bg-green-500 text-white' : idx === activeStep ? 'bg-blue-500 text-white animate-pulse' : 'bg-slate-200 text-slate-500'}`}>
                      {idx < activeStep ? '✓' : idx + 1}
                    </div>
                    <span className={`text-sm ${idx === activeStep ? 'font-bold text-blue-600' : 'font-medium text-slate-600'}`}>{step}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {results.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="p-6 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                <h3 className="text-lg font-bold text-slate-800">Extraction Results</h3>
                <span className="text-xs font-bold bg-green-100 text-green-700 px-3 py-1 rounded-full">{results.length} Processed</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead className="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
                    <tr>
                      <th className="p-5">Company</th>
                      <th className="p-5">Total Assets</th>
                      <th className="p-5">ODLA</th>
                      <th className="p-5">Deficiency</th>
                      <th className="p-5">BBL/CBILS</th>
                      <th className="p-5">HMRC</th>
                      <th className="p-5">Trade Creditors</th>
                      <th className="p-5">Accountant</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {results.map((row, idx) => (
                      <tr key={idx} className="hover:bg-slate-50 transition-colors">
                        <td className="p-5">
                          <div className="font-bold text-slate-800">{row.companyName}</div>
                          <div className="text-xs text-slate-400 font-mono mt-1">{row.companyNumber}</div>
                        </td>
                        <td className="p-5 font-mono text-slate-600">{row.total_assets}</td>
                        <td className="p-5 font-mono text-red-500 font-semibold bg-red-50/50">{row.odla}</td>
                        <td className="p-5 font-mono text-slate-600">{row.total_deficiency}</td>
                        <td className="p-5 font-mono text-slate-600">{row.bbl_cbils}</td>
                        <td className="p-5 font-mono text-xs text-slate-600">
                          <span className="text-slate-400 mr-1">Pref:</span>{row.hmrc_preferential} <br/>
                          <span className="text-slate-400 mr-1">Unsec:</span>{row.hmrc_unsecured}
                        </td>
                        <td className="p-5 font-mono text-slate-600">{row.trade_creditors}</td>
                        <td className="p-5">
                          <span className="px-3 py-1 bg-slate-100 text-slate-700 rounded-md font-medium text-xs">{row.accountant_firm}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}