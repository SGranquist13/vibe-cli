import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Copy text to clipboard (cross-platform)
 * Returns true if successful, false otherwise
 */
export async function copyToClipboard(text: string): Promise<boolean> {
    const platform = process.platform;
    let command: string;

    try {
        if (platform === 'win32') {
            // Windows: use PowerShell Set-Clipboard with proper escaping
            // Escape single quotes by doubling them, then wrap in single quotes
            const escapedText = text.replace(/'/g, "''");
            command = `powershell -Command "Set-Clipboard -Value '${escapedText}'"`;
        } else if (platform === 'darwin') {
            // macOS: use pbcopy
            // Escape double quotes and newlines
            const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
            command = `printf "%s" "${escapedText}" | pbcopy`;
        } else {
            // Linux: try xclip first, then xsel
            // Try xclip first (more common)
            try {
                const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
                await execAsync(`printf "%s" "${escapedText}" | xclip -selection clipboard`);
                return true;
            } catch {
                // Fall back to xsel
                const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
                await execAsync(`printf "%s" "${escapedText}" | xsel --clipboard --input`);
                return true;
            }
        }

        await execAsync(command);
        return true;
    } catch (error) {
        // Clipboard copy failed, but that's okay - user can copy manually
        return false;
    }
}

