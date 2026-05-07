import sys
import json

def main():
    for line in sys.stdin:
        data = json.loads(line)
        # Spec 2에서 구현
        print(json.dumps({"status": "not_implemented"}), flush=True)

if __name__ == "__main__":
    main()
