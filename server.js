// GET EMAILS - MORE ROBUST
app.post("/api/emails", async (req, res) => {
  const { email, password, folder, page = 1, pageSize = 25, unreadOnly = false } = req.body;
  const boxName = folder || "INBOX";
  
  console.log(`Fetching emails: ${email}, folder: ${boxName}, page: ${page}, unreadOnly: ${unreadOnly}`);
  const imap = createImapConnection(email, password);

  try {
    await connectImap(imap);
    
    const openBox = promisify(imap.openBox.bind(imap));
    const box = await openBox(boxName, true);
    console.log(`Box opened. Total: ${box.messages.total}`);
    
    if (box.messages.total === 0) {
      imap.end();
      return res.json({
        emails: [],
        pagination: { page: 1, pageSize, totalMessages: 0, totalPages: 0, hasMore: false }
      });
    }
    
    const search = promisify(imap.search.bind(imap));
    const searchCriteria = unreadOnly ? ['UNSEEN'] : ['ALL'];
    const uids = await search(searchCriteria);
    console.log(`Found ${uids.length} UIDs`);
    
    const totalMessages = uids.length;
    const totalPages = Math.ceil(totalMessages / pageSize);
    
    const startIdx = Math.max(0, totalMessages - (page * pageSize));
    const endIdx = totalMessages - ((page - 1) * pageSize);
    const pageUids = uids.slice(startIdx, endIdx).reverse();
    
    console.log(`Fetching ${pageUids.length} messages (UIDs: ${pageUids.slice(0, 5).join(',')}...)`);
    
    if (pageUids.length === 0) {
      imap.end();
      return res.json({
        emails: [],
        pagination: { page, pageSize, totalMessages, totalPages, hasMore: page < totalPages }
      });
    }
    
    const emails = await new Promise((resolve, reject) => {
      const results = [];
      const processed = new Set();
      let completed = 0;
      
      const fetchTimeout = setTimeout(() => {
        console.log(`Fetch timeout - processed ${completed}/${pageUids.length}, returning ${results.length} results`);
        resolve(results);
      }, 20000);
      
      const fetch = imap.fetch(pageUids, {
        bodies: '',
        struct: true
      });
      
      fetch.on('message', (msg, seqno) => {
        let uid;
        let buffer = Buffer.alloc(0);
        
        msg.on('body', (stream, info) => {
          stream.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
          });
        });
        
        msg.once('attributes', (attrs) => {
          uid = attrs.uid;
        });
        
        msg.once('end', async () => {
          completed++;
          
          if (!uid || processed.has(uid)) {
            return;
          }
          processed.add(uid);
          
          try {
            if (buffer.length === 0) {
              console.log(`Empty buffer for UID ${uid}`);
              return;
            }
            
            const parsed = await simpleParser(buffer);
            
            const preview = (parsed.text || parsed.textAsHtml || '')
              .replace(/<[^>]*>/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .substring(0, 150);
            
            const emailObj = {
              id: uid,
              subject: parsed.subject || "(No subject)",
              from: parsed.from?.value?.[0]?.name || parsed.from?.text || "Unknown",
              fromAddress: parsed.from?.value?.[0]?.address || "",
              to: parsed.to?.text || "",
              date: parsed.date || new Date(),
              timestamp: parsed.date ? parsed.date.getTime() : Date.now(),
              unread: msg.attributes ? !msg.attributes.flags.includes('\\Seen') : true,
              starred: msg.attributes ? msg.attributes.flags.includes('\\Flagged') : false,
              preview: preview || "(No preview)"
            };
            
            results.push(emailObj);
          } catch (err) {
            console.error(`Parse error for UID ${uid}:`, err.message);
          }
        });
      });
      
      fetch.once('error', (err) => {
        console.error('Fetch stream error:', err.message);
        clearTimeout(fetchTimeout);
        resolve(results);
      });
      
      fetch.once('end', () => {
        clearTimeout(fetchTimeout);
        results.sort((a, b) => b.timestamp - a.timestamp);
        console.log(`Fetch complete: ${results.length} emails parsed from ${pageUids.length} UIDs`);
        resolve(results);
      });
    });
    
    imap.end();
    
    res.json({
      emails,
      pagination: {
        page,
        pageSize,
        totalMessages,
        totalPages,
        hasMore: page < totalPages
      }
    });
  } catch (err) {
    console.error("Fetch error:", err.message);
    try { imap.destroy(); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});
