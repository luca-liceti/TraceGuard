# 🔒 TraceGuard

**A Privacy-First Browser Extension for PII Tracking and Management**

TraceGuard is a comprehensive browser extension that helps you track, monitor, and manage your personally identifiable information (PII) as you browse the web. With military-grade encryption and intelligent form detection, TraceGuard keeps you informed about when and where your sensitive data is being used.

## ✨ Features

### 🛡️ **Encrypted Data Vault**
- **AES-GCM 256-bit encryption** for all stored data
- **PBKDF2** key derivation with 200,000 iterations
- **Local-only storage** - your data never leaves your device
- **Master password protection** with SHA-256 hashing

### 🔍 **Intelligent PII Detection**
- **Real-time monitoring** of form inputs across all websites
- **Automatic detection** of emails, phone numbers, SSNs, credit cards, and more
- **Hash-based matching** for privacy-preserving detection
- **Visual notifications** when your information is detected

### 📊 **Comprehensive Dashboard**
- **Activity logs** showing when and where your data was used
- **Manual entry management** with search and filtering
- **Profile-based detection** for automatic monitoring
- **Site-by-site tracking** with detailed analytics

### 🌐 Sites (Data Deletion Requests)
- Maintain a list of sites you want to contact about data deletion
- Add a site in the dashboard and use the "Send delete request" action to open the site's contact page or a pre-filled email
- TraceGuard will attempt a best-effort contact discovery (mailto/contact/privacy links) when you add a site and will persist discovered contact info for easier requests

### 🔔 **Smart Notifications**
- **Browser badges** showing PII usage count per site
- **Pop-up alerts** when sensitive information is detected
- **Cooldown periods** to prevent notification spam
- **Field context** showing exactly where data was used

### 📱 **Multi-Interface Design**
- **Popup interface** for quick access and management
- **Full dashboard** for detailed analysis and configuration
- **Responsive design** working on all screen sizes
- **Dark/light mode** support following system preferences

## 🚀 Installation

### From Source (Developer Mode)

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/traceguard.git
   cd traceguard
   ```

2. **Load in Chrome/Edge:**
   - Open `chrome://extensions/`
   - Enable "Developer mode" (top-right toggle)
   - Click "Load unpacked"
   - Select the `traceguard` folder

3. **Load in Firefox:**
   - Open `about:debugging`
   - Click "This Firefox"
   - Click "Load Temporary Add-on"
   - Select any file in the `traceguard` folder

## 📖 Usage Guide

### Initial Setup

1. **Click the TraceGuard extension icon** in your browser toolbar
2. **Create a master password** (minimum 6 characters)
3. **Confirm your password** and click "Create Password"
4. Your encrypted vault is now ready!

### Adding Information to Your Profile

1. **Open TraceGuard popup** and switch to the "My Profile" tab
2. **Select information type** (Email, Phone, SSN, etc.)
3. **Enter your information** and click "Add to Profile"
4. This information will now be **automatically detected** on websites

### Manual Entry Storage

1. **Switch to "Manual Entry" tab** in the popup
2. **Select the type** of information you want to store
3. **Enter sensitive data** and click "Save (encrypt)"
4. Data is **encrypted and stored locally** for your reference

### Viewing Activity Logs

1. **Open the "Activity Logs" tab** to see detection history
2. **Filter by site or type** to find specific entries
3. **View detailed information** about when and where data was used
4. **Clear logs** when no longer needed

### Using the Full Dashboard

1. **Click "Dashboard →"** in the popup footer
2. Access **comprehensive analytics** and management tools
3. **Filter and search** across all your data
4. **Export or clear** data as needed

## 🔒 Security Features

### Encryption Details
- **Algorithm:** AES-GCM with 256-bit keys
- **Key Derivation:** PBKDF2 with SHA-256, 200,000 iterations
- **Salt:** Unique 16-byte random salt per installation
- **IV:** Unique 12-byte initialization vector per encryption

### Privacy Protection
- **Local-only storage** - no cloud synchronization
- **Hash-based detection** - original values never stored in plaintext for detection
- **No telemetry** - no usage data transmitted
- **Open source** - fully auditable code

### Data Types Supported
- 📧 **Email addresses**
- 📱 **Phone numbers** 
- 🏠 **Physical addresses**
- 🔢 **Social Security Numbers**
- 💳 **Credit card numbers**
- 🆔 **Driver's license numbers**
- 📘 **Passport numbers**
- ➕ **Custom data types**

## 🛠️ Development

### Project Structure
```
traceguard/
├── manifest.json          # Extension configuration
├── background.js          # Service worker for badge management
├── content.js            # Form monitoring and detection
├── popup.html            # Main interface markup
├── popup-enhanced.js     # Popup functionality
├── popup.css            # Styling
├── dashboard.html       # Full dashboard interface
├── dashboard-enhanced.js # Dashboard functionality
├── README.md           # This file
├── (new) tg_sites storage key: used to store Sites list for deletion requests
└── README.md           # This file
```

### Key Technologies
- **Chrome Extension Manifest V3**
- **Web Crypto API** for encryption
- **Chrome Storage API** for local data
- **Modern JavaScript** (ES2020+)
- **CSS Grid/Flexbox** for responsive design

## Notes for Developers — Sites & Contact Discovery
- New storage key: `tg_sites` stores an array of site objects { origin, contactUrl?, email? }
- Contact discovery is implemented in `dashboard-enhanced.js::discoverContactsForSite(siteObj)` as a best-effort, client-side HTML fetch and parse
   - It may fail silently due to CORS restrictions; if so the extension will still allow manual open/email flows
   - Consider adding a server-side discovery endpoint for more reliable discovery (opt-in) if CORS becomes a blocker

### Building and Testing

1. **Make changes** to the source files
2. **Reload the extension** in `chrome://extensions/`
3. **Test on various websites** to ensure detection works
4. **Check console logs** for any errors
5. **Verify encryption** by examining stored data

## 🧪 Testing Detection

### How to Test Automatic Detection:

1. **Add information to your profile:**
   - Open TraceGuard popup
   - Go to "My Profile" tab
   - Add your email: `test@example.com`
   - Add your phone: `5551234567`

2. **Visit a test website:**
   - Go to any website with forms (e.g., registration pages)
   - Try typing your email or phone number in form fields

3. **Verify detection:**
   - You should see a **blue notification** appear when typing
   - Check the **browser badge** - it should show a count
   - View **Activity Logs** tab to see the detection recorded

4. **Test different scenarios:**
   - Try typing with different formatting (e.g., phone with dashes)
   - Test on different field types (input, textarea)
   - Verify detection works on multiple sites

### Troubleshooting Detection:

- **No notifications?** Check if vault is unlocked
- **Badge not showing?** Refresh the page after adding profile data
- **Detection not working?** Check browser console for JavaScript errors
- **Still having issues?** Try removing and re-adding profile entries

## 🤝 Contributing

We welcome contributions! Please read our contributing guidelines:

1. **Fork the repository**
2. **Create a feature branch:** `git checkout -b feature/amazing-feature`
3. **Make your changes** and test thoroughly
4. **Commit with clear messages:** `git commit -m 'Add amazing feature'`
5. **Push to your branch:** `git push origin feature/amazing-feature`
6. **Open a Pull Request**

### Development Guidelines
- Follow existing code style and patterns
- Test all features thoroughly before submitting
- Update documentation for new features
- Ensure security best practices are maintained

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🚨 Security Disclosure

If you discover a security vulnerability, please email us privately at `security@traceguard.dev` instead of opening a public issue.

## 📞 Support

- **Issues:** [GitHub Issues](https://github.com/yourusername/traceguard/issues)
- **Documentation:** [Wiki](https://github.com/yourusername/traceguard/wiki)
- **Discussions:** [GitHub Discussions](https://github.com/yourusername/traceguard/discussions)

---

**⚠️ Important Security Note:** TraceGuard stores all data locally on your device. If you forget your master password, your encrypted data cannot be recovered. Always use a password you can remember or store it securely.

**📱 Browser Compatibility:** TraceGuard works on Chrome, Edge, Brave, and other Chromium-based browsers. Firefox support is experimental.

---

*Built with privacy in mind. Your data belongs to you.*