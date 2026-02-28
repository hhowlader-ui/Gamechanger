import express from "express";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import { search } from "duck-duck-scrape";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "50mb" }));

  app.post("/api/extract", async (req, res) => {
    try {
      const { companyNumber, chApiKey } = req.body;
      if (!companyNumber || !chApiKey) {
        return res.status(400).json({ error: "Company Number and Companies House API Key are required." });
      }

      const authHeader = `Basic ${Buffer.from(`${chApiKey}:`).toString("base64")}`;

      // 1. Companies House Fetch
      const companyRes = await fetch(`https://api.company-information.service.gov.uk/company/${companyNumber}`, {
        headers: { Authorization: authHeader }
      });
      if (!companyRes.ok) {
        throw new Error(`Failed to fetch company details: ${companyRes.statusText}`);
      }
      const companyData = await companyRes.json();

      // Fetch filing history
      const filingRes = await fetch(`https://api.company-information.service.gov.uk/company/${companyNumber}/filing-history?items_per_page=100`, {
        headers: { Authorization: authHeader }
      });
      if (!filingRes.ok) {
        throw new Error(`Failed to fetch filing history: ${filingRes.statusText}`);
      }
      const filingData = await filingRes.json();

      // Fetch officers for Director name
      const officersRes = await fetch(`https://api.company-information.service.gov.uk/company/${companyNumber}/officers`, {
        headers: { Authorization: authHeader }
      });
      let directorName = "";
      if (officersRes.ok) {
        const officersData = await officersRes.json();
        const director = officersData.items?.find((o: any) => o.officer_role === "director");
        if (director) {
          directorName = director.name;
        }
      }

      // 2. Document Sorting
      const items = filingData.items || [];
      const soaItem = items.find((item: any) => item.category === "insolvency" && item.description?.includes("statement-of-affairs"));
      const accountItems = items.filter((item: any) => item.category === "accounts").slice(0, 3);

      async function downloadPdf(documentMetadataUrl: string): Promise<string> {
        const res = await fetch(documentMetadataUrl, {
          headers: {
            Authorization: authHeader,
            Accept: "application/pdf"
          }
        });
        if (!res.ok) {
          throw new Error(`Failed to download PDF: ${res.statusText}`);
        }
        const buffer = await res.arrayBuffer();
        return Buffer.from(buffer).toString("base64");
      }

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      let extractedData: any = {};

      // 3. PDF Processing & AI Extraction
      if (soaItem && soaItem.links?.document_metadata) {
        try {
          const soaPdfBase64 = await downloadPdf(soaItem.links.document_metadata);
          const response = await ai.models.generateContent({
            model: "gemini-3.1-pro-preview",
            contents: {
              parts: [
                {
                  inlineData: {
                    data: soaPdfBase64,
                    mimeType: "application/pdf"
                  }
                },
                {
                  text: "Extract Total Assets (estimated to realise), ODLA, Total Deficiency, BBL/CBILS, HMRC Preferential, HMRC Unsecured, Trade Creditors, and the Accountant Firm Name. Return as JSON."
                }
              ]
            },
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  totalAssets: { type: Type.STRING },
                  odla: { type: Type.STRING },
                  totalDeficiency: { type: Type.STRING },
                  bblCbils: { type: Type.STRING },
                  hmrcPreferential: { type: Type.STRING },
                  hmrcUnsecured: { type: Type.STRING },
                  tradeCreditors: { type: Type.STRING },
                  accountantFirmName: { type: Type.STRING }
                }
              }
            }
          });
          extractedData = JSON.parse(response.text || "{}");
        } catch (e) {
          console.error("Failed to extract SoA", e);
        }
      }

      // 4. Fallback Logic
      if (!extractedData.accountantFirmName && accountItems.length > 0) {
        for (const accItem of accountItems) {
          if (accItem.links?.document_metadata) {
            try {
              const accPdfBase64 = await downloadPdf(accItem.links.document_metadata);
              const accResponse = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: {
                  parts: [
                    {
                      inlineData: {
                        data: accPdfBase64,
                        mimeType: "application/pdf"
                      }
                    },
                    {
                      text: "Extract the Accountant Firm Name from this document. Return as JSON."
                    }
                  ]
                },
                config: {
                  responseMimeType: "application/json",
                  responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                      accountantFirmName: { type: Type.STRING }
                    }
                  }
                }
              });
              const accData = JSON.parse(accResponse.text || "{}");
              if (accData.accountantFirmName) {
                extractedData.accountantFirmName = accData.accountantFirmName;
                break;
              }
            } catch (e) {
              console.error("Failed to extract Accounts", e);
            }
          }
        }
      }

      // 5. Ethnicity AI
      let ethnicity = "";
      if (directorName) {
        try {
          const ethResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: `Guess the broad ethnicity based on onomastics for the name: ${directorName}. Return as JSON with a single property 'ethnicity'.`,
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: { ethnicity: { type: Type.STRING } }
              }
            }
          });
          ethnicity = JSON.parse(ethResponse.text || "{}").ethnicity;
        } catch (e) {
          console.error("Failed to extract ethnicity", e);
        }
      }

      // 6. Web Search
      let accountantUrl = "";
      if (extractedData.accountantFirmName) {
        try {
          const searchResults = await search(`${extractedData.accountantFirmName} UK`);
          if (searchResults.results && searchResults.results.length > 0) {
            accountantUrl = searchResults.results[0].url;
          }
        } catch (e) {
          console.error("Web search failed", e);
        }
      }

      // 7. Return combined data
      res.json({
        companyName: companyData.company_name,
        companyNumber: companyData.company_number,
        directorName,
        ethnicity,
        totalAssets: extractedData.totalAssets || "",
        odla: extractedData.odla || "",
        totalDeficiency: extractedData.totalDeficiency || "",
        bblCbils: extractedData.bblCbils || "",
        hmrcPreferential: extractedData.hmrcPreferential || "",
        hmrcUnsecured: extractedData.hmrcUnsecured || "",
        tradeCreditors: extractedData.tradeCreditors || "",
        accountantFirmName: extractedData.accountantFirmName || "",
        accountantUrl
      });
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
