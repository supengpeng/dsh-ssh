/**
 * §4.2 connection profiles.
 *
 * Two invariants from the ICD are enforced here rather than trusted to the UI:
 *
 *   - **Nothing that leaves this file contains a plaintext credential.** Every
 *     profile crosses the wire through `toConnProfileView`, whose `secrets` member
 *     is a presence/provenance/fixed-mask triple; the reference *names* travel
 *     alongside because a reference is not a secret and without it an edited
 *     profile could not be saved back without orphaning its stored credential
 *     (ICD v1.0.5).
 *   - **A secret is written through the credential seam, never into the profile
 *     file.** `setSecret` delegates to the resolver, which stores the value with
 *     `ctx.credentials` and writes only the reference into the profile.
 *
 * `setSecret`'s answer is a deliberate superset of the frozen `{ ref }`:
 * `persisted: false` means "this value is good for the current process only" —
 * the documented outcome when the launching environment already supplies the
 * reference (that value is read-only for this run). It is a **normal degradation,
 * not a failure**, and the UI is expected to say so instead of showing an error.
 */
import { type ConnProfileView } from '../store.js';
import { type ErrorInfo } from '../protocol.js';
import { type Params } from './params.js';
import { ApiGroup } from './deps.js';
export declare class ProfilesApi extends ApiGroup {
    /** ICD §4.2 `listProfiles`. */
    list(): Promise<{
        profiles: ConnProfileView[];
    }>;
    /** ICD §4.2 `saveProfile`. */
    save(params: Params): Promise<{
        profile: ConnProfileView;
    }>;
    /** ICD §4.2 `deleteProfile`. */
    remove(params: Params): Promise<{
        deleted: true;
    }>;
    /** ICD §4.2 `duplicateProfile`. */
    duplicate(params: Params): Promise<{
        profile: ConnProfileView;
    }>;
    /**
     * ICD §4.2 `testProfile`: connect once, report what happened, leave nothing behind.
     *
     * If the profile is already connected the answer is derived from that live
     * session — re-connecting (and then closing) could tear down the connection the
     * user is working in, which is a spectacular way for a "test" button to break a
     * terminal.
     */
    test(params: Params): Promise<{
        ok: boolean;
        latencyMs?: number;
        serverBanner?: string;
        hostKeyFingerprint?: string;
        error?: ErrorInfo;
    }>;
    /** ICD §4.2 `setSecret`. */
    setSecret(params: Params): Promise<{
        ref: string;
        masked: string;
        persisted: boolean;
        reason?: string;
    }>;
    /** ICD §4.2 `clearSecret`. */
    clearSecret(params: Params): Promise<{
        cleared: true;
    }>;
    /** The profile a request names: by id, by inline body, or the two combined (an error). */
    private profileFrom;
    private oneShot;
    private fingerprintFor;
    /**
     * A host-key prompt reached an endpoint with no UI waiting on it (`testProfile`
     * has no session to key the prompt against), so it is refused explicitly rather
     * than left hanging: the structured error tells the user to connect (where the
     * prompt is wired) or to trust the key first.
     */
    private promptHostKey;
    private warnDirect;
}
//# sourceMappingURL=profiles.d.ts.map