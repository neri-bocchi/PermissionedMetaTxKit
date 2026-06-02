// PMTXHub Console CLI (Go)
// Administra y usa el contrato PermissionedMetaTxHub desde consola.
//
// Requisitos:
//   go 1.21+
//   go get github.com/ethereum/go-ethereum@v1.14.11
//   go get github.com/spf13/cobra@v1.8.1
//   (opcional) un .env simple: export RPC_URL=..., HUB_ADDRESS=..., OWNER_PRIVATE_KEY=..., RELAYER_PRIVATE_KEY=...
//
// Build:
//   go mod init pmtxhub-cli-go
//   go mod tidy
//   go build -o pmtxhub
//
// Uso:
//   ./pmtxhub --help
//   ./pmtxhub view caller 0xRELAYER
//   ./pmtxhub admin set-caller 0xRELAYER true
//   ./pmtxhub sign --from 0xA --to 0xB --space 0 --nonce 1 --deadline 1924999999 --caller 0xRELAYER --data 0x... --pk 0x...
//   ./pmtxhub execute --forward forward.json
package main

import (
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/params"
	apitypes "github.com/ethereum/go-ethereum/signer/core/apitypes"
	"github.com/spf13/cobra"
)

const (
	DomainName    = "PermissionedMetaTxHub"
	DomainVersion = "1"
)

// ====== ABI mínimo ======
const hubABIJSON = `[
  {"type":"function","name":"gasUsedThisBlock","stateMutability":"view","inputs":[{"name":"caller","type":"address"}],"outputs":[{"type":"uint256"},{"type":"uint256"},{"type":"uint256"}]},
  {"type":"function","name":"deployGasWindowState","stateMutability":"view","inputs":[{"name":"from","type":"address"}],"outputs":[{"type":"uint256"},{"type":"uint256"},{"type":"uint64"},{"type":"uint64"},{"type":"uint256"}]},
  {"type":"function","name":"isCallerAllowed","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"gasLimitPerBlock","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"gasAccountingOverhead","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"erc2771AppendSender","stateMutability":"view","inputs":[],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"allowedDeployers","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"type":"bool"}]},
  {"type":"function","name":"usedDigest","stateMutability":"view","inputs":[{"name":"","type":"bytes32"}],"outputs":[{"type":"bool"}]},

  {"type":"function","name":"setCallerAllowed","stateMutability":"nonpayable","inputs":[{"name":"caller","type":"address"},{"name":"allowed","type":"bool"}],"outputs":[]},
  {"type":"function","name":"setGasLimitPerBlock","stateMutability":"nonpayable","inputs":[{"name":"caller","type":"address"},{"name":"limit","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setGasAccountingOverhead","stateMutability":"nonpayable","inputs":[{"name":"overhead","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"setErc2771AppendSender","stateMutability":"nonpayable","inputs":[{"name":"enabled","type":"bool"}],"outputs":[]},
  {"type":"function","name":"setDeployGasBucketConfig","stateMutability":"nonpayable","inputs":[{"name":"limit","type":"uint256"},{"name":"durationSeconds","type":"uint64"}],"outputs":[]},
  {"type":"function","name":"setAllowedDeployer","stateMutability":"nonpayable","inputs":[{"name":"account","type":"address"},{"name":"allowed","type":"bool"}],"outputs":[]},
  {"type":"function","name":"setAllowedDeployers","stateMutability":"nonpayable","inputs":[{"name":"accounts","type":"address[]"},{"name":"allowed","type":"bool"}],"outputs":[]},

  {"type":"function","name":"execute","stateMutability":"payable","inputs":[{"name":"f","type":"tuple","components":[
    {"name":"from","type":"address"},
    {"name":"to","type":"address"},
    {"name":"value","type":"uint256"},
    {"name":"space","type":"uint32"},
    {"name":"nonce","type":"uint256"},
    {"name":"deadline","type":"uint256"},
    {"name":"dataHash","type":"bytes32"},
    {"name":"caller","type":"address"}
  ]},{"name":"data","type":"bytes"},{"name":"signature","type":"bytes"}],"outputs":[]}
]`

// Forward tuple en Go para abi.Pack
// Mantener mismo orden y tipos compatibles.
type Forward struct {
	From     common.Address
	To       common.Address
	Value    *big.Int
	Space    uint32
	Nonce    *big.Int
	Deadline *big.Int
	DataHash [32]byte
	Caller   common.Address
}

// Paquete que guardamos/cargamos al firmar
type SignedPackage struct {
	Domain  apitypes.TypedDataDomain `json:"domain"`
	Forward struct {
		From     string `json:"from"`
		To       string `json:"to"`
		Value    string `json:"value"` // wei string
		Space    uint32 `json:"space"`
		Nonce    string `json:"nonce"`
		Deadline string `json:"deadline"`
		DataHash string `json:"dataHash"`
		Caller   string `json:"caller"`
	} `json:"forward"`
	Data      string `json:"data"`
	Signature string `json:"signature"`
}

// ===== util =====
func mustEnv(key string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		log.Fatalf("Falta variable de entorno: %s", key)
	}
	return v
}

func getEnv(key, def string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	return v
}

func hexTo32(input string) ([32]byte, error) {
	var out [32]byte
	b, err := hex.DecodeString(strings.TrimPrefix(input, "0x"))
	if err != nil {
		return out, err
	}
	if len(b) != 32 {
		return out, fmt.Errorf("bytes32 inválido: len=%d", len(b))
	}
	copy(out[:], b)
	return out, nil
}

func mustChainID(ctx context.Context, c *ethclient.Client) *big.Int {
	id, err := c.ChainID(ctx)
	if err != nil {
		log.Fatalf("ChainID error: %v", err)
	}
	return id
}

func suggestGas(ctx context.Context, c *ethclient.Client) (*big.Int, error) {
	return c.SuggestGasPrice(ctx)
}

func parseBool(s string) (bool, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "true" || s == "1" || s == "yes" { return true, nil }
	if s == "false" || s == "0" || s == "no" { return false, nil }
	return false, fmt.Errorf("bool inválido: %s", s)
}

// ==== firma EIP-712 ====
func buildTypedData(chainID *big.Int, verifying common.Address) apitypes.TypedData {
	return apitypes.TypedData{
		Types: apitypes.Types{
			"EIP712Domain": {
				{Name: "name", Type: "string"},
				{Name: "version", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"Forward": {
				{Name: "from", Type: "address"},
				{Name: "to", Type: "address"},
				{Name: "value", Type: "uint256"},
				{Name: "space", Type: "uint32"},
				{Name: "nonce", Type: "uint256"},
				{Name: "deadline", Type: "uint256"},
				{Name: "dataHash", Type: "bytes32"},
				{Name: "caller", Type: "address"},
			},
		},
		PrimaryType: "Forward",
		Domain: apitypes.TypedDataDomain{
			Name:              DomainName,
			Version:           DomainVersion,
			ChainId:           (*apitypes.JSONNumber)(bigIntAsJSON(chainID)),
			VerifyingContract: verifying.Hex(),
		},
	}
}

func bigIntAsJSON(n *big.Int) *json.Number {
	s := json.Number(n.String())
	return &s
}

func signForward(priv *ecdsa.PrivateKey, td apitypes.TypedData, msg map[string]interface{}) (string, error) {
	// Hash EIP-712 y firmar
	hash, err := apitypes.TypedDataHash(td, msg)
	if err != nil {
		return "", err
	}
	sig, err := crypto.Sign(hash, priv)
	if err != nil {
		return "", err
	}
	// Ajustar V a 27/28 si fuese necesario (go-ethereum ya deja 27/28)
	if sig[64] < 27 { sig[64] += 27 }
	return "0x" + hex.EncodeToString(sig), nil
}

// ===== main =====
func main() {
	root := &cobra.Command{Use: "pmtxhub", Short: "CLI para PermissionedMetaTxHub (Go)"}

	root.PersistentFlags().String("rpc", getEnv("RPC_URL", ""), "RPC URL (env RPC_URL)\n")
	root.PersistentFlags().String("hub", getEnv("HUB_ADDRESS", ""), "Dirección del contrato Hub (env HUB_ADDRESS)")

	// ----- view -----
	viewCmd := &cobra.Command{Use: "view", Short: "Consultas de estado"}
	viewCaller := &cobra.Command{Use: "caller [address]", Args: cobra.ExactArgs(1), Run: func(cmd *cobra.Command, args []string) {
		rpc, _ := root.Flags().GetString("rpc")
		hub, _ := root.Flags().GetString("hub")
		c, err := ethclient.Dial(rpc)
		if err != nil { log.Fatal(err) }
		defer c.Close()
		ctx := context.Background()
		abiHub, err := abi.JSON(strings.NewReader(hubABIJSON))
		if err != nil { log.Fatal(err) }

		caller := common.HexToAddress(args[0])
		hubAddr := common.HexToAddress(hub)

		// isCallerAllowed
		data, _ := abiHub.Pack("isCallerAllowed", caller)
		res, err := c.CallContract(ctx, types.CallMsg{To: &hubAddr, Data: data}, nil)
		if err != nil { log.Fatal(err) }
		vals, _ := abiHub.Unpack("isCallerAllowed", res)
		allowed := vals[0].(bool)

		// gasLimitPerBlock
		data, _ = abiHub.Pack("gasLimitPerBlock", caller)
		res, err = c.CallContract(ctx, types.CallMsg{To: &hubAddr, Data: data}, nil)
		if err != nil { log.Fatal(err) }
		vals, _ = abiHub.Unpack("gasLimitPerBlock", res)
		limit := vals[0].(*big.Int)

		// gasUsedThisBlock
		data, _ = abiHub.Pack("gasUsedThisBlock", caller)
		res, err = c.CallContract(ctx, types.CallMsg{To: &hubAddr, Data: data}, nil)
		if err != nil { log.Fatal(err) }
		vals, _ = abiHub.Unpack("gasUsedThisBlock", res)
		used := vals[0].(*big.Int)
		lim := vals[1].(*big.Int)
		blockNo := vals[2].(*big.Int)

		fmt.Printf("{\n  allowed: %v,\n  limitCfg: %s,\n  runtime: { used: %s, limit: %s, blockNo: %d }\n}\n", allowed, limit, used, lim, blockNo)
	}}
	viewDeploy := &cobra.Command{Use: "deploy-window [from]", Args: cobra.ExactArgs(1), Run: func(cmd *cobra.Command, args []string) {
		rpc, _ := root.Flags().GetString("rpc")
		hub, _ := root.Flags().GetString("hub")
		c, err := ethclient.Dial(rpc)
		if err != nil { log.Fatal(err) }
		defer c.Close()
		ctx := context.Background()
		abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
		hubAddr := common.HexToAddress(hub)
		from := common.HexToAddress(args[0])
		data, _ := abiHub.Pack("deployGasWindowState", from)
		res, err := c.CallContract(ctx, types.CallMsg{To: &hubAddr, Data: data}, nil)
		if err != nil { log.Fatal(err) }
		vals, _ := abiHub.Unpack("deployGasWindowState", res)
		used := vals[0].(*big.Int)
		limit := vals[1].(*big.Int)
		startedAt := vals[2].(uint64)
		duration := vals[3].(uint64)
		nowTs := vals[4].(*big.Int)
		remaining := new(big.Int).Sub(limit, used)
		if remaining.Sign() < 0 { remaining = big.NewInt(0) }
		fmt.Printf("{\n  used: %s,\n  limit: %s,\n  startedAt: %d,\n  duration: %d,\n  now: %s,\n  remaining: %s\n}\n", used, limit, startedAt, duration, nowTs, remaining)
	}}
	viewFlags := &cobra.Command{Use: "flags", Run: func(cmd *cobra.Command, args []string) {
		rpc, _ := root.Flags().GetString("rpc")
		hub, _ := root.Flags().GetString("hub")
		c, err := ethclient.Dial(rpc)
		if err != nil { log.Fatal(err) }
		defer c.Close()
		ctx := context.Background()
		abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
		hubAddr := common.HexToAddress(hub)
		data, _ := abiHub.Pack("erc2771AppendSender")
		res, err := c.CallContract(ctx, types.CallMsg{To: &hubAddr, Data: data}, nil)
		if err != nil { log.Fatal(err) }
		vals, _ := abiHub.Unpack("erc2771AppendSender", res)
		appendSender := vals[0].(bool)
		data, _ = abiHub.Pack("gasAccountingOverhead")
		res, _ = c.CallContract(ctx, types.CallMsg{To: &hubAddr, Data: data}, nil)
		vals, _ = abiHub.Unpack("gasAccountingOverhead", res)
		overhead := vals[0].(*big.Int)
		fmt.Printf("{ erc2771AppendSender: %v, gasAccountingOverhead: %s }\n", appendSender, overhead)
	}}
	viewAllowed := &cobra.Command{Use: "allowed-deployer [addr]", Args: cobra.ExactArgs(1), Run: func(cmd *cobra.Command, args []string) {
		rpc, _ := root.Flags().GetString("rpc")
		hub, _ := root.Flags().GetString("hub")
		c, _ := ethclient.Dial(rpc)
		defer c.Close()
		ctx := context.Background()
		abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
		hubAddr := common.HexToAddress(hub)
		addr := common.HexToAddress(args[0])
		data, _ := abiHub.Pack("allowedDeployers", addr)
		res, err := c.CallContract(ctx, types.CallMsg{To: &hubAddr, Data: data}, nil)
		if err != nil { log.Fatal(err) }
		vals, _ := abiHub.Unpack("allowedDeployers", res)
		fmt.Printf("{ account: %s, allowed: %v }\n", addr.Hex(), vals[0].(bool))
	}}
	viewDigest := &cobra.Command{Use: "digest [0x..32]", Args: cobra.ExactArgs(1), Run: func(cmd *cobra.Command, args []string) {
		rpc, _ := root.Flags().GetString("rpc")
		hub, _ := root.Flags().GetString("hub")
		c, _ := ethclient.Dial(rpc)
		defer c.Close()
		ctx := context.Background()
		abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
		hubAddr := common.HexToAddress(hub)
		dig := common.HexToHash(args[0])
		data, _ := abiHub.Pack("usedDigest", dig)
		res, err := c.CallContract(ctx, types.CallMsg{To: &hubAddr, Data: data}, nil)
		if err != nil { log.Fatal(err) }
		vals, _ := abiHub.Unpack("usedDigest", res)
		fmt.Printf("{ digest: %s, used: %v }\n", dig.Hex(), vals[0].(bool))
	}} 
	viewCmd.AddCommand(viewCaller, viewDeploy, viewFlags, viewAllowed, viewDigest)
	root.AddCommand(viewCmd)

	// ----- admin -----
	adminCmd := &cobra.Command{Use: "admin", Short: "Funciones onlyOwner"}

	withOwnerTx := func(send func(ctx context.Context, c *ethclient.Client, chainID *big.Int, hubAddr common.Address, from common.Address, pk *ecdsa.PrivateKey) (common.Hash, error)) func(cmd *cobra.Command, args []string) {
		return func(cmd *cobra.Command, args []string) {
			rpc, _ := root.Flags().GetString("rpc")
			hub, _ := root.Flags().GetString("hub")
			pkHex := getEnv("OWNER_PRIVATE_KEY", "")
			if pkHex == "" { log.Fatal("OWNER_PRIVATE_KEY requerido para admin") }
			if strings.HasPrefix(pkHex, "0x") { pkHex = pkHex[2:] }
			pkBytes, _ := hex.DecodeString(pkHex)
			pk, err := crypto.ToECDSA(pkBytes)
			if err != nil { log.Fatal(err) }

			c, err := ethclient.Dial(rpc)
			if err != nil { log.Fatal(err) }
			defer c.Close()
			ctx := context.Background()
			chainID := mustChainID(ctx, c)
			hubAddr := common.HexToAddress(hub)
			from := crypto.PubkeyToAddress(pk.PublicKey)
			h, err := send(ctx, c, chainID, hubAddr, from, pk)
			if err != nil { log.Fatal(err) }
			fmt.Println("tx:", h.Hex())
		}
	}

adminSetCaller := &cobra.Command{
    Use:  "set-caller [caller] [true|false]",
    Args: cobra.ExactArgs(2),
    Run: withOwnerTx(func(ctx context.Context, c *ethclient.Client, chainID *big.Int,
        hubAddr common.Address, from common.Address, pk *ecdsa.PrivateKey) (common.Hash, error) {

        caller := common.HexToAddress(os.Args[len(os.Args)-2])
        b, err := parseBool(os.Args[len(os.Args)-1])
        if err != nil {
            return common.Hash{}, err
        }

        abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
        payload, _ := abiHub.Pack("setCallerAllowed", caller, b)
        return sendTx(ctx, c, chainID, from, hubAddr, big.NewInt(0), payload, pk)
    }),
}


	adminSetGasLimit := &cobra.Command{Use: "set-gaslimit [caller] [limit]", Args: cobra.ExactArgs(2), Run: withOwnerTx(func(ctx context.Context, c *ethclient.Client, chainID *big.Int, hubAddr common.Address, from common.Address, pk *ecdsa.PrivateKey) (common.Hash, error) {
		caller := common.HexToAddress(os.Args[len(os.Args)-2])
		limit := new(big.Int)
		limit, ok := limit.SetString(os.Args[len(os.Args)-1], 10)
		if !ok { return common.Hash{}, errors.New("limit inválido") }
		abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
		payload, _ := abiHub.Pack("setGasLimitPerBlock", caller, limit)
		return sendTx(ctx, c, chainID, from, hubAddr, big.NewInt(0), payload, pk)
	}))

	adminSetOverhead := &cobra.Command{Use: "set-overhead [overhead]", Args: cobra.ExactArgs(1), Run: withOwnerTx(func(ctx context.Context, c *ethclient.Client, chainID *big.Int, hubAddr common.Address, from common.Address, pk *ecdsa.PrivateKey) (common.Hash, error) {
		overhead := new(big.Int)
		overhead, ok := overhead.SetString(os.Args[len(os.Args)-1], 10)
		if !ok { return common.Hash{}, errors.New("overhead inválido") }
		abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
		payload, _ := abiHub.Pack("setGasAccountingOverhead", overhead)
		return sendTx(ctx, c, chainID, from, hubAddr, big.NewInt(0), payload, pk)
	}))

	adminSetErc2771 := &cobra.Command{Use: "set-erc2771 [true|false]", Args: cobra.ExactArgs(1), Run: withOwnerTx(func(ctx context.Context, c *ethclient.Client, chainID *big.Int, hubAddr common.Address, from common.Address, pk *ecdsa.PrivateKey) (common.Hash, error) {
		b, err := parseBool(os.Args[len(os.Args)-1])
		if err != nil { return common.Hash{}, err }
		abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
		payload, _ := abiHub.Pack("setErc2771AppendSender", b)
		return sendTx(ctx, c, chainID, from, hubAddr, big.NewInt(0), payload, pk)
	}))

	adminSetDeployBucket := &cobra.Command{Use: "set-deploy-bucket [limit] [durationSeconds]", Args: cobra.ExactArgs(2), Run: withOwnerTx(func(ctx context.Context, c *ethclient.Client, chainID *big.Int, hubAddr common.Address, from common.Address, pk *ecdsa.PrivateKey) (common.Hash, error) {
		limit := new(big.Int)
		limit, ok := limit.SetString(os.Args[len(os.Args)-2], 10)
		if !ok { return common.Hash{}, errors.New("limit inválido") }
		dur64, err := strconv.ParseUint(os.Args[len(os.Args)-1], 10, 64)
		if err != nil { return common.Hash{}, err }
		abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
		payload, _ := abiHub.Pack("setDeployGasBucketConfig", limit, dur64)
		return sendTx(ctx, c, chainID, from, hubAddr, big.NewInt(0), payload, pk)
	}))

	adminSetAllowedDeployer := &cobra.Command{Use: "set-allowed-deployer [addr] [true|false]", Args: cobra.ExactArgs(2), Run: withOwnerTx(func(ctx context.Context, c *ethclient.Client, chainID *big.Int, hubAddr common.Address, from common.Address, pk *ecdsa.PrivateKey) (common.Hash, error) {
		addr := common.HexToAddress(os.Args[len(os.Args)-2])
		b, err := parseBool(os.Args[len(os.Args)-1])
		if err != nil { return common.Hash{}, err }
		abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
		payload, _ := abiHub.Pack("setAllowedDeployer", addr, b)
		return sendTx(ctx, c, chainID, from, hubAddr, big.NewInt(0), payload, pk)
	}))

	adminSetAllowedDeployers := &cobra.Command{Use: "set-allowed-deployers [file.json] [true|false]", Args: cobra.ExactArgs(2), Run: withOwnerTx(func(ctx context.Context, c *ethclient.Client, chainID *big.Int, hubAddr common.Address, from common.Address, pk *ecdsa.PrivateKey) (common.Hash, error) {
		path := os.Args[len(os.Args)-2]
		b, err := parseBool(os.Args[len(os.Args)-1])
		if err != nil { return common.Hash{}, err }
		raw, err := os.ReadFile(path)
		if err != nil { return common.Hash{}, err }
		var arr []string
		if err := json.Unmarshal(raw, &arr); err != nil { return common.Hash{}, err }
		addrs := make([]common.Address, 0, len(arr))
		for _, s := range arr { addrs = append(addrs, common.HexToAddress(s)) }
		abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
		payload, _ := abiHub.Pack("setAllowedDeployers", addrs, b)
		return sendTx(ctx, c, chainID, from, hubAddr, big.NewInt(0), payload, pk)
	}))

	adminCmd.AddCommand(adminSetCaller, adminSetGasLimit, adminSetOverhead, adminSetErc2771, adminSetDeployBucket, adminSetAllowedDeployer, adminSetAllowedDeployers)
	root.AddCommand(adminCmd)

	// ----- sign -----
	signCmd := &cobra.Command{Use: "sign", Short: "Firma EIP-712 del Forward (EOA)"}
	fromS := signCmd.Flags().String("from", "", "from")
	toS := signCmd.Flags().String("to", "", "to (0x0 para CREATE)")
	valueS := signCmd.Flags().String("value", "0", "value en ETH o wei (si contiene 'wei')")
	spaceS := signCmd.Flags().Uint32("space", 0, "space")
	nonceS := signCmd.Flags().String("nonce", "0", "nonce (uint256)")
	deadlineS := signCmd.Flags().String("deadline", "0", "deadline (unix seconds)")
	callerS := signCmd.Flags().String("caller", "", "caller (relayer)")
	dataS := signCmd.Flags().String("data", "0x", "calldata/bytecode hex")
	pkS := signCmd.Flags().String("pk", "", "private key del FROM (0x...) ")
	signCmd.Run = func(cmd *cobra.Command, args []string) {
		rpc, _ := root.Flags().GetString("rpc")
		hub, _ := root.Flags().GetString("hub")
		if *fromS == "" || *toS == "" || *callerS == "" || *pkS == "" { log.Fatal("--from --to --caller --pk requeridos") }
		client, err := ethclient.Dial(rpc)
		if err != nil { log.Fatal(err) }
		defer client.Close()
		ctx := context.Background()
		chainID := mustChainID(ctx, client)

		// value
		value := new(big.Int)
		if strings.Contains(*valueS, "wei") {
			value, _ = value.SetString(strings.TrimSuffix(*valueS, "wei"), 10)
		} else {
			// parse as ETH
			f, err := strconv.ParseFloat(*valueS, 64)
			if err != nil { log.Fatal(err) }
			value = new(big.Int).Mul(big.NewInt(int64(f*1e9)), big.NewInt(params.GWei)) // aproximación
		}

		// dataHash
		dataHex := strings.TrimSpace(*dataS)
		if !strings.HasPrefix(dataHex, "0x") { dataHex = "0x" + dataHex }
		dataBytes, err := hex.DecodeString(strings.TrimPrefix(dataHex, "0x"))
		if err != nil { log.Fatal(err) }
		dataHash := crypto.Keccak256Hash(dataBytes)

		// build typed data
		domain := buildTypedData(chainID, common.HexToAddress(hub))
		msg := map[string]interface{}{
			"from":    common.HexToAddress(*fromS),
			"to":      common.HexToAddress(*toS),
			"value":   value,
			"space":   *spaceS,
			"nonce":   strToBig(*nonceS),
			"deadline": strToBig(*deadlineS),
			"dataHash": dataHash,
			"caller":  common.HexToAddress(*callerS),
		}

		pk := mustPriv(*pkS)
		sigHex, err := signForward(pk, domain, msg)
		if err != nil { log.Fatal(err) }

		pkg := SignedPackage{Domain: domain}
		pkg.Forward.From = common.HexToAddress(*fromS).Hex()
		pkg.Forward.To = common.HexToAddress(*toS).Hex()
		pkg.Forward.Value = value.String()
		pkg.Forward.Space = *spaceS
		pkg.Forward.Nonce = strToBig(*nonceS).String()
		pkg.Forward.Deadline = strToBig(*deadlineS).String()
		pkg.Forward.DataHash = dataHash.Hex()
		pkg.Forward.Caller = common.HexToAddress(*callerS).Hex()
		pkg.Data = dataHex
		pkg.Signature = sigHex

		enc, _ := json.MarshalIndent(pkg, "", "  ")
		fmt.Println(string(enc))
	}
	root.AddCommand(signCmd)

	// ----- execute -----
	execCmd := &cobra.Command{Use: "execute", Short: "Llama execute() como relayer"}
	forwardPath := execCmd.Flags().String("forward", "", "archivo JSON (salida de sign)")
	valueWei := execCmd.Flags().String("value", "", "override value en wei (opcional)")
	execCmd.Run = func(cmd *cobra.Command, args []string) {
		rpc, _ := root.Flags().GetString("rpc")
		hub, _ := root.Flags().GetString("hub")
		pkHex := getEnv("RELAYER_PRIVATE_KEY", "")
		if pkHex == "" { log.Fatal("RELAYER_PRIVATE_KEY requerido") }
		if *forwardPath == "" { log.Fatal("--forward requerido") }

		raw, err := os.ReadFile(*forwardPath)
		if err != nil { log.Fatal(err) }
		var pkg SignedPackage
		if err := json.Unmarshal(raw, &pkg); err != nil { log.Fatal(err) }

		dataBytes, err := hex.DecodeString(strings.TrimPrefix(pkg.Data, "0x"))
		if err != nil { log.Fatal(err) }
		dh := crypto.Keccak256Hash(dataBytes)
		if !strings.EqualFold(dh.Hex(), pkg.Forward.DataHash) { log.Fatal("dataHash no coincide con data") }

		pk := mustPriv(pkHex)
		from := crypto.PubkeyToAddress(pk.PublicKey)
		client, err := ethclient.Dial(rpc)
		if err != nil { log.Fatal(err) }
		defer client.Close()
		ctx := context.Background()
		chainID := mustChainID(ctx, client)
		hubAddr := common.HexToAddress(hub)

		val := new(big.Int)
		val, ok := val.SetString(pkg.Forward.Value, 10)
		if !ok { log.Fatal("value inválido") }
		if *valueWei != "" {
			if v2, ok2 := new(big.Int).SetString(*valueWei, 10); ok2 { val = v2 }
		}

		// construir tuple Forward
		var dh32 [32]byte
		dh32, _ = hexTo32(strings.TrimPrefix(pkg.Forward.DataHash, "0x"))
		fwd := Forward{
			From:     common.HexToAddress(pkg.Forward.From),
			To:       common.HexToAddress(pkg.Forward.To),
			Value:    val,
			Space:    pkg.Forward.Space,
			Nonce:    strToBig(pkg.Forward.Nonce),
			Deadline: strToBig(pkg.Forward.Deadline),
			DataHash: dh32,
			Caller:   common.HexToAddress(pkg.Forward.Caller),
		}

		// ABI pack
		abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
		sigBytes, _ := hex.DecodeString(strings.TrimPrefix(pkg.Signature, "0x"))
		payload, err := abiHub.Pack("execute", fwd, dataBytes, sigBytes)
		if err != nil { log.Fatal(err) }

		// gas price & estimate
		gasPrice, err := suggestGas(ctx, client)
		if err != nil { log.Fatal(err) }
		gasLimit, err := client.EstimateGas(ctx, types.CallMsg{From: from, To: &hubAddr, Value: val, Data: payload})
		if err != nil { log.Fatal(err) }

		nonce, err := client.PendingNonceAt(ctx, from)
		if err != nil { log.Fatal(err) }

		tx := types.NewTransaction(nonce, hubAddr, val, gasLimit, gasPrice, payload)
		signed, err := types.SignTx(tx, types.LatestSignerForChainID(chainID), pk)
		if err != nil { log.Fatal(err) }
		if err := client.SendTransaction(ctx, signed); err != nil { log.Fatal(err) }
		fmt.Println("tx:", signed.Hash().Hex())
	}
	root.AddCommand(execCmd)

	// ----- chain -----
	chainCmd := &cobra.Command{Use: "chain", Short: "Muestra chainId y hub"}
	chainCmd.Run = func(cmd *cobra.Command, args []string) {
		rpc, _ := root.Flags().GetString("rpc")
		hub, _ := root.Flags().GetString("hub")
		c, err := ethclient.Dial(rpc)
		if err != nil { log.Fatal(err) }
		defer c.Close()
		id, err := c.ChainID(context.Background())
		if err != nil { log.Fatal(err) }
		fmt.Printf("{ chainId: %s, hub: %s }\n", id, common.HexToAddress(hub).Hex())
	}
	root.AddCommand(chainCmd)

	if err := root.Execute(); err != nil {
		log.Fatal(err)
	}
}

// ===== helpers =====
func sendTx(ctx context.Context, c *ethclient.Client, chainID *big.Int, from common.Address, to common.Address, value *big.Int, data []byte, pk *ecdsa.PrivateKey) (common.Hash, error) {
	gasPrice, err := c.SuggestGasPrice(ctx)
	if err != nil { return common.Hash{}, err }
	gasLimit, err := c.EstimateGas(ctx, types.CallMsg{From: from, To: &to, Value: value, Data: data})
	if err != nil { return common.Hash{}, err }
	nonce, err := c.PendingNonceAt(ctx, from)
	if err != nil { return common.Hash{}, err }
	tx := types.NewTransaction(nonce, to, value, gasLimit, gasPrice, data)
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(chainID), pk)
	if err != nil { return common.Hash{}, err }
	if err := c.SendTransaction(ctx, signed); err != nil { return common.Hash{}, err }
	return signed.Hash(), nil
}

func mustPriv(hexPk string) *ecdsa.PrivateKey {
	h := strings.TrimPrefix(hexPk, "0x")
	b, err := hex.DecodeString(h)
	if err != nil { log.Fatal(err) }
	pk, err := crypto.ToECDSA(b)
	if err != nil { log.Fatal(err) }
	return pk
}

func strToBig(s string) *big.Int {
	n := new(big.Int)
	n, _ = n.SetString(strings.TrimSpace(s), 10)
	return n
}

